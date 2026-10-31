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

import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import path from 'path';
import vm from 'vm';

import type { ConnectedTabGroup, TabOwner } from '../../packages/extension/src/connectedTabGroup';
import type { RelayConnection } from '../../packages/extension/src/relayConnection';

// Bundle only class definitions: never execute the extension's background bootstrap.
const code = buildSync({
  stdin: {
    contents: "export { ConnectedTabGroup } from './connectedTabGroup'; export { RelayConnection } from './relayConnection';",
    resolveDir: path.resolve(__dirname, '../../packages/extension/src'),
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'extensionUnderTest',
}).outputFiles[0].text;

function event<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>();
  return {
    listeners,
    addListener: (listener: (...args: Args) => void) => listeners.add(listener),
    removeListener: (listener: (...args: Args) => void) => listeners.delete(listener),
    emit: (...args: Args) => [...listeners].forEach(listener => listener(...args)),
  };
}

class Socket {
  readyState = 1;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send(_message: string) {}
  close() {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.());
  }
  command(method: string, params: unknown[]) {
    this.onmessage?.({ data: JSON.stringify({ id: 1, method, params }) });
  }
  disconnect() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function environment(order: 'before-cache' | 'after-cache') {
  const updated = event<[number, { groupId: number }, chrome.tabs.Tab]>();
  const removed = event<[number]>();
  const created = event<unknown[]>();
  const debuggerEvent = event<unknown[]>();
  const debuggerDetach = event<unknown[]>();
  const events = [updated, removed, created, debuggerEvent, debuggerDetach];
  const tabs = new Map([11, 12, 13, 14, 15, 21].map(id => [id, { id, groupId: -1, url: 'about:blank' } as chrome.tabs.Tab]));
  const calls = { removed: [] as number[], ungrouped: [] as number[], detached: [] as number[] };
  const errors: unknown[][] = [];
  const update = (id: number) => updated.emit(id, { groupId: tabs.get(id)!.groupId }, tabs.get(id)!);
  let nextGroup = 1;
  const chrome = {
    tabs: {
      onUpdated: updated, onRemoved: removed, onCreated: created,
      group: async ({ tabIds, groupId = nextGroup++ }: { tabIds: number[], groupId?: number }) => {
        for (const id of tabIds) {
          tabs.get(id)!.groupId = groupId;
          if (order === 'before-cache')
            update(id);
        }
        return groupId;
      },
      ungroup: async (ids: number[]) => {
        for (const id of ids) {
          calls.ungrouped.push(id);
          tabs.get(id)!.groupId = -1;
          update(id);
        }
      },
      remove: async (ids: number | number[]) => {
        for (const id of [ids].flat()) {
          calls.removed.push(id);
          tabs.delete(id);
          removed.emit(id);
        }
      },
    },
    tabGroups: {
      update: async (groupId: number) => {
        if (order === 'before-cache') {
          for (const [id, tab] of tabs) {
            if (tab.groupId === groupId)
              update(id);
          }
        }
      },
    },
    debugger: {
      onEvent: debuggerEvent, onDetach: debuggerDetach,
      attach: async () => {},
      detach: async ({ tabId }: { tabId: number }) => { calls.detached.push(tabId); },
    },
    action: { setBadgeText: async () => {}, setTitle: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  const sandbox = { chrome, WebSocket: { OPEN: 1 }, setTimeout, console: { log: (...args: unknown[]) => errors.push(args) } };
  const classes = vm.runInNewContext(`${code}\nextensionUnderTest`, sandbox, { timeout: 1000 }) as {
    ConnectedTabGroup: typeof ConnectedTabGroup, RelayConnection: typeof RelayConnection,
  };
  const connect = (id: number, owner: TabOwner) => {
    const socket = new Socket();
    const relay = new classes.RelayConnection(socket as unknown as WebSocket, 2);
    const group = new classes.ConnectedTabGroup(relay, tabs.get(id)!, 'Offline', owner);
    return { socket, relay, group };
  };
  const attach = async (socket: Socket, id: number) => {
    socket.command('chrome.debugger.attach', [{ tabId: id }, '1.3']);
    await settle();
    if (order === 'after-cache')
      update(id);
  };
  return { tabs, calls, errors, update, connect, attach, listeners: () => events.map(e => e.listeners.size) };
}

for (const owner of ['user', 'agent'] as const) {
  for (const order of ['before-cache', 'after-cache'] as const) {
    for (const trigger of ['socket', 'manual'] as const) {
      test(`disconnect preserves tabs: ${owner}, ${order}, ${trigger}`, async () => {
        const env = environment(order);
        const first = env.connect(11, owner);
        await env.attach(first.socket, 11);
        // This tab predates the connection, but relay attach can classify it as agent-owned.
        await env.attach(first.socket, 12);
        const second = env.connect(21, 'agent');
        await env.attach(second.socket, 21);
        const secondGroup = env.tabs.get(21)!.groupId;
        // A user drags another existing tab into the first group.
        env.tabs.get(13)!.groupId = env.tabs.get(11)!.groupId;
        env.update(13);
        await env.attach(first.socket, 13);
        const ownership = first.group as unknown as { _agentOwnedTabs: Set<number>, _pendingOwner: Map<number, TabOwner> };
        if (order === 'before-cache')
          expect(ownership._agentOwnedTabs.has(12)).toBe(true);
        expect(first.relay.attachedTabs.size).toBe(3);
        expect(env.listeners()).toEqual([2, 4, 2, 2, 2]);
        let closed = 0;
        first.group.onclose = () => ++closed;
        if (trigger === 'socket')
          first.socket.disconnect();
        else
          first.group.close('Offline disconnect');
        await settle();
        expect(first.socket.readyState).toBe(3);
        expect(env.calls.removed).toEqual([]);
        expect([...env.tabs.keys()]).toEqual([11, 12, 13, 14, 15, 21]);
        expect([...env.calls.ungrouped].sort()).toEqual([11, 12, 13]);
        expect([...env.calls.detached].sort()).toEqual([11, 12, 13]);
        for (const id of [11, 12, 13, 14, 15])
          expect(env.tabs.get(id)!.groupId).toBe(-1);
        expect(env.tabs.get(21)!.groupId).toBe(secondGroup);
        expect([...second.relay.attachedTabs]).toEqual([21]);
        expect(second.socket.readyState).toBe(1);
        expect(first.group.connectedTabIds()).toEqual([]);
        expect(first.relay.attachedTabs.size).toBe(0);
        expect(ownership._agentOwnedTabs.size).toBe(0);
        expect(ownership._pendingOwner.size).toBe(0);
        expect(env.listeners()).toEqual([1, 2, 1, 1, 1]);
        const cleanup = JSON.stringify(env.calls);
        first.socket.disconnect();
        first.group.close('Repeated disconnect');
        await settle();
        expect(JSON.stringify(env.calls)).toBe(cleanup);
        expect(closed).toBe(1);
        second.group.close('Offline cleanup');
        await settle();
        expect(env.calls.removed).toEqual([]);
        expect(env.calls.detached.length).toBe(4);
        expect(env.calls.ungrouped.length).toBe(4);
        expect(env.listeners()).toEqual([0, 0, 0, 0, 0]);
        expect(env.errors).toEqual([]);
      });
    }
  }
}

test('an explicit tab close still removes only the requested tab', async () => {
  const env = environment('before-cache');
  const { socket, group } = env.connect(11, 'user');
  await env.attach(socket, 11);
  socket.command('chrome.tabs.remove', [15]);
  await settle();
  expect(env.calls.removed).toEqual([15]);
  expect(env.tabs.has(15)).toBe(false);
  expect([...env.tabs.keys()]).toEqual([11, 12, 13, 14, 21]);
  group.close('Offline cleanup');
  await settle();
  expect(env.calls.removed).toEqual([15]);
  expect(env.tabs.has(11)).toBe(true);
  expect(env.listeners()).toEqual([0, 0, 0, 0, 0]);
  expect(env.errors).toEqual([]);
});
