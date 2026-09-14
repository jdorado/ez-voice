import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function fixture() {
  const elements = new Map();
  const tracks = [];
  const requests = [];
  let stopResolve;
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (!elements.has(id))
          elements.set(id, {
            dataset: {},
            hidden: false,
            setAttribute(k, v) {
              this[k] = v;
            },
            play: async () => {},
          });
        return elements.get(id);
      },
    },
    sessionStorage: { getItem: () => "fixture", removeItem() {}, setItem() {} },
    location: { hash: "" },
    history: { replaceState() {} },
    window: { addEventListener() {} },
    setTimeout() {},
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          const track = {
            enabled: true,
            stopped: false,
            stop() {
              this.stopped = true;
            },
          };
          tracks.push(track);
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        },
      },
    },
    RTCPeerConnection: class {
      addTrack() {}
      close() {}
      createDataChannel() {
        return (this.channel = { close() {} });
      }
      async createOffer() {
        return { sdp: "offer" };
      }
      async setLocalDescription() {}
      async setRemoteDescription() {
        this.channel.onmessage({data:JSON.stringify({type:"session.started",session:{id:"live_fixture"}})});
      }
    },
    fetch: async (path, options) => {
      requests.push({ path, options });
      if (path === "/stop")
        return await new Promise((resolve) => {
          stopResolve = () =>
            resolve({
              ok: true,
              json: async () => ({ hangupConfirmed: true }),
            });
        });
      return {
        ok: true,
        json: async () =>
          path === "/session"
            ? { sdp: "answer" }
            : { agent: "Test", events: [], history: { messages: [] } },
      };
    },
  });
  vm.runInContext(source, context);
  return {
    elements,
    tracks,
    requests,
    run: (code) => vm.runInContext(code, context),
    finishStop: () => stopResolve(),
  };
}

test("call controls mute audio and keep restart locked until hangup settles", async () => {
  const f = fixture();
  await flush();
  assert.equal(f.elements.get("start").disabled, false);
  f.elements.get("start").onclick();
  await flush();
  assert.equal(f.elements.get("mute").hidden, false);
  f.elements.get("mute").onclick();
  assert.equal(f.tracks[0].enabled, false);
  assert.equal(f.elements.get("mute")["aria-pressed"], "true");
  f.elements.get("mute").onclick();
  assert.equal(f.tracks[0].enabled, true);
  f.elements.get("stop").onclick();
  await flush();
  f.run('readStatus({events:[{seq:1,type:"closed"}]})');
  assert.equal(f.elements.get("start").disabled, true);
  assert.equal(f.tracks[0].stopped, false);
  f.finishStop();
  await flush();
  assert.equal(f.tracks[0].stopped, true);
  assert.equal(f.elements.get("start").disabled, false);
  f.elements.get("start").onclick();
  await flush();
  f.run('readStatus({events:[{seq:1,type:"closed"}]})');
  assert.equal(f.tracks[1].stopped, false);
  assert.equal(f.elements.get("mute").hidden, false);
});

test("new conversation requests fresh history and ignores closed while connecting", async () => {
  const f = fixture();
  await flush();
  f.elements.get("new").onclick();
  f.run('readStatus({events:[{seq:1,type:"closed"}]})');
  await flush();
  const session = f.requests.find((r) => r.path === "/session");
  assert.equal(JSON.parse(session.options.body).resume, false);
  assert.equal(f.tracks[0].stopped, false);
  assert.equal(f.elements.get("mute").hidden, false);
});
