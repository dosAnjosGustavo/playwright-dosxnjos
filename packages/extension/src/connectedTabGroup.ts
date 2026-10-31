/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { RelayConnection, debugLog } from './relayConnection';

export const PLAYWRIGHT_GROUP_TITLE = 'Playwright';
const PLAYWRIGHT_GROUP_COLOR = 'green';
const NON_DEBUGGABLE_SCHEMES = ['chrome:', 'edge:', 'devtools:'];
const CONNECTED_BADGE = { text: '✓', color: '#4CAF50', title: 'Connected to Playwright client' };

export function isNonDebuggableUrl(url: string | undefined): boolean {
  return !!url && NON_DEBUGGABLE_SCHEMES.some(s => url.startsWith(s));
}

// Tracks how a tab entered the connection's group. Relay attachment can also
// classify an existing tab as agent-owned, so ownership never authorizes
// closing a tab when the connection ends.
export type TabOwner = 'agent' | 'user';

// Ungroups any Playwright-titled groups left behind by a prior service worker.
// Titles now vary per connection (`Playwright · <clientName>`, see
// PlaywrightExtension._reserveGroupTitle), so match by prefix instead of the
// old exact-title query — chrome.tabGroups.query({title}) does not support
// patterns, so we query all groups and filter here.
export async function cleanupStalePlaywrightGroups(): Promise<void> {
  try {
    const groups = await chrome.tabGroups.query({});
    const staleGroups = groups.filter(g => g.title?.startsWith(PLAYWRIGHT_GROUP_TITLE));
    const tabsPerGroup = await Promise.all(staleGroups.map(g => chrome.tabs.query({ groupId: g.id })));
    const tabIds = tabsPerGroup.flat().map(t => t.id).filter((id): id is number => id !== undefined);
    if (tabIds.length)
      await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
  } catch (error: any) {
    debugLog('Error cleaning up stale groups:', error);
  }
}

// The Playwright tab group for an active RelayConnection. The Chrome tab group
// is the single source of truth for which tabs the client targets:
//  - User drags a tab in/out → `_onTabGroupChanged` attaches/detaches.
//  - Relay attaches on its own (initial tab, popup, Target.createTarget) →
//    `_onTabAttached` pulls the new tab into the group, whose onUpdated event
//    flows back through `_onTabGroupChanged` for consistency.
// `_groupTabIds` caches group membership from Chrome events so hot-path checks
// in `_onTabUpdated` stay synchronous.
export class ConnectedTabGroup {
  private _connection: RelayConnection;
  private _groupId: number | null = null;
  private _groupTitle: string;
  private _groupTabIds: Set<number> = new Set();
  // Agent ownership recorded on group entry, cleared on exit or disconnect.
  // A later re-attach (e.g. after navigation) never re-decides ownership for
  // an existing member. Both owners survive a connection closing.
  private _agentOwnedTabs: Set<number> = new Set();
  // Owner intended for the next tab that enters the group via an
  // agent-initiated path (seed tab, or `_addTabToGroup` from a relay attach).
  // `_onTabGroupChanged` consumes it when the membership change lands; a
  // group-entry with no pending entry (typically a user drag) defaults to
  // 'user'.
  private _pendingOwner: Map<number, TabOwner> = new Map();
  private _onTabUpdatedListener: (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void;
  private _onTabRemovedListener: (tabId: number) => void;

  onclose?: () => void;
  // Fired when the client asks (via session.setGroupLabel) to relabel this
  // connection's group. The caller (background.ts's PlaywrightExtension) owns
  // cross-connection dedupe - see _reserveGroupTitle - so it computes the
  // final title and calls setLabel() back; this callback only carries the
  // raw requested label up to whoever can see every active connection.
  onlabelrequest?: (label: string) => Promise<void>;

  constructor(connection: RelayConnection, selectedTab: chrome.tabs.Tab, groupTitle: string = PLAYWRIGHT_GROUP_TITLE, seedOwner: TabOwner = 'agent') {
    this._connection = connection;
    this._groupTitle = groupTitle;
    this._connection.onclose = () => this._onConnectionClose();
    this._connection.ontabattached = (tabId: number) => this._onTabAttached(tabId);
    this._connection.ontabdetached = (tabId: number) => this._onTabDetached(tabId);
    this._connection.onsetgrouplabel = (label: string) => this._onLabelRequested(label);
    this._onTabUpdatedListener = this._onTabUpdated.bind(this);
    this._onTabRemovedListener = this._onTabRemoved.bind(this);
    chrome.tabs.onUpdated.addListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.addListener(this._onTabRemovedListener);
    // Seed ownership: 'agent' for the token/newTab bypass path (no tab was
    // picked), 'user' when the connect page's tab picker chose an existing
    // tab — see PlaywrightExtension._connectTab.
    if (selectedTab.id !== undefined)
      this._pendingOwner.set(selectedTab.id, seedOwner);
    // Seed the relay with the user-selected tab, then close out the initial
    // handshake. The relay holds Playwright-side CDP traffic until
    // `didInitialize` arrives, so it sees a fully populated tab model by the
    // time it handles `Target.setAutoAttach`.
    this._connection.attachTab(selectedTab);
    this._connection.didInitialize();
  }

  connectedTabIds(): number[] {
    return [...this._groupTabIds];
  }

  close(reason: string): void {
    this._connection.close(reason);
  }

  private async _onLabelRequested(label: string): Promise<void> {
    if (!this.onlabelrequest)
      throw new Error('No label handler registered for this connection');
    await this.onlabelrequest(label);
  }

  // Applies an already-deduped, already-prefixed title (see background.ts's
  // _reserveGroupTitle) to this connection's Chrome tab group. Takes the
  // final title rather than the raw label so the "Playwright · X" prefix and
  // (2)/(3) dedupe suffix are computed in exactly one place - the caller,
  // which is also the only place with visibility into every other active
  // connection's current title.
  async setLabel(title: string): Promise<void> {
    this._groupTitle = title;
    if (this._groupId !== null)
      await chrome.tabGroups.update(this._groupId, { title });
  }

  private _onTabUpdated(tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab): void {
    if (changeInfo.groupId !== undefined)
      this._onTabGroupChanged(tabId, tab);
    if (changeInfo.url === undefined)
      return;
    // Chrome resets per-tab badge state on navigation, so re-apply it.
    if (this._connection.attachedTabs.has(tabId))
      void this._updateBadge(tabId, CONNECTED_BADGE);
    else if (this._groupTabIds.has(tabId) && !isNonDebuggableUrl(changeInfo.url))
      this._connection.attachTab(tab);
  }

  // Single entry point for group membership changes, whether the user dragged
  // or we grouped the tab ourselves. Attaches on entry (if debuggable) and
  // detaches on exit; a chrome:// tab stays in the group until it navigates
  // (handled in _onTabUpdated).
  //
  // This is also the single point where tab ownership is decided (D2): a
  // group-entry consumes `_pendingOwner` (set by the constructor for the seed
  // tab, or by `_onTabAttached` for a relay-initiated attach) if present,
  // otherwise the entry was a raw user drag and defaults to 'user'. Deciding
  // ownership only here — never on re-attach — means a later navigation of an
  // already-grouped tab can't retroactively promote it to agent-owned.
  private _onTabGroupChanged(tabId: number, tab: chrome.tabs.Tab): void {
    const inOurGroup = this._groupId !== null && tab.groupId === this._groupId;
    const wasInGroup = this._groupTabIds.has(tabId);
    if (inOurGroup === wasInGroup)
      return;
    if (inOurGroup) {
      this._groupTabIds.add(tabId);
      const owner = this._pendingOwner.get(tabId) ?? 'user';
      this._pendingOwner.delete(tabId);
      if (owner === 'agent')
        this._agentOwnedTabs.add(tabId);
      if (!isNonDebuggableUrl(tab.url))
        this._connection.attachTab(tab);
    } else {
      this._groupTabIds.delete(tabId);
      this._agentOwnedTabs.delete(tabId);
      if (this._connection.attachedTabs.has(tabId))
        this._connection.detachTab(tabId);
    }
  }

  private _onTabRemoved(tabId: number): void {
    this._groupTabIds.delete(tabId);
    this._agentOwnedTabs.delete(tabId);
    this._pendingOwner.delete(tabId);
  }

  // A relay-initiated attach (popup, `browser_tabs new`, `Target.createTarget`)
  // is agent-owned by default. Only register that when there's no pending
  // owner yet and the tab isn't already a group member: the constructor
  // pre-registers the seed tab's owner (which may be 'user', from the tab
  // picker) before its own attachTab call reaches here, and a re-attach of an
  // existing member (e.g. after navigation) must not re-decide ownership —
  // see `_onTabGroupChanged`.
  private _onTabAttached(tabId: number): void {
    void this._updateBadge(tabId, CONNECTED_BADGE);
    if (!this._groupTabIds.has(tabId) && !this._pendingOwner.has(tabId))
      this._pendingOwner.set(tabId, 'agent');
    void this._addTabToGroup(tabId);
  }

  // The debugger detached (drag-out, tab close, or external action). Clear the
  // badge but leave the tab in the group — the user's intent is still there,
  // and a subsequent navigation will re-attach via _onTabUpdated.
  private _onTabDetached(tabId: number): void {
    void this._updateBadge(tabId, { text: '' });
  }

  // Preserve every tab on manual disconnect or connection loss. Even tabs
  // classified as agent-owned may predate the connection or contain useful
  // work. Leaving agent-created tabs open is intentional; closing a tab must
  // remain an explicit, separate action.
  private _onConnectionClose(): void {
    chrome.tabs.onUpdated.removeListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.removeListener(this._onTabRemovedListener);
    const groupTabs = [...this._groupTabIds];
    this._groupTabIds.clear();
    this._agentOwnedTabs.clear();
    this._pendingOwner.clear();
    if (groupTabs.length) {
      this._retryOnDrag(() => chrome.tabs.ungroup(groupTabs as [number, ...number[]])).catch(error => {
        debugLog('Error ungrouping tabs on close:', error);
      });
    }
    this.onclose?.();
  }

  private async _updateBadge(tabId: number, { text, color, title }: { text: string; color?: string, title?: string }): Promise<void> {
    try {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text }),
        chrome.action.setTitle({ tabId, title: title || '' }),
        color ? chrome.action.setBadgeBackgroundColor({ tabId, color }) : Promise.resolve(),
      ]);
    } catch (error: any) {
      // Ignore errors as the tab may be closed already.
    }
  }

  // Moves an already-attached tab into our Chrome tab group, creating it on
  // first use. `_groupTabIds` is updated after the await so an onUpdated event
  // that arrives concurrently (`_groupId` still null, wasInGroup still false)
  // becomes a harmless no-op rather than taking the drag-out branch.
  private async _addTabToGroup(tabId: number): Promise<void> {
    if (this._groupTabIds.has(tabId))
      return;
    try {
      await this._retryOnDrag(async () => {
        if (this._groupId === null) {
          this._groupId = await chrome.tabs.group({ tabIds: [tabId] });
          await chrome.tabGroups.update(this._groupId, { color: PLAYWRIGHT_GROUP_COLOR, title: this._groupTitle });
        } else {
          await chrome.tabs.group({ groupId: this._groupId, tabIds: [tabId] });
        }
      });
      this._groupTabIds.add(tabId);
    } catch (error: any) {
      debugLog('Error adding tab to group:', error);
    }
  }

  // Chrome throws "user may be dragging a tab" while a drag is in progress.
  // Retry with backoff until it clears (or we give up).
  private async _retryOnDrag(fn: () => Promise<void>): Promise<void> {
    const delays = [0, 100, 200, 400, 800];
    let lastError: unknown;
    for (const delay of delays) {
      if (delay)
        await new Promise(resolve => setTimeout(resolve, delay));
      try {
        await fn();
        return;
      } catch (error: any) {
        if (!error?.message?.includes('user may be dragging a tab'))
          throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
}
