import net from "node:net";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { frames, send } from "./protocol.mjs";
import { CoreTools } from "./plugin-tools.mjs";
import { WebAuth } from "./web-auth.mjs";
import { serveWeb } from "./web-server.mjs";

// HTTP stays inside Docker. Only framed tool requests cross the core connection.
export async function webConnect(state, args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--origin", "--bot-id"].includes(args[i]) ||
      !args[i + 1] ||
      options[args[i]]
    )
      throw Error("Expected web --origin ORIGIN [--bot-id ID]");
    options[args[i]] = args[i + 1];
  }
  const core = new CoreTools(process.stdout),
    pending = new Map(),
    owner = randomBytes(32).toString("hex");
  const socket = net.connect(join(state, "voice.sock"));
  let web,
    closing = false;
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (closing) return reject(Error("Voice connection closed"));
      const id = randomUUID(),
        timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("Voice request timed out"));
        }, 60000);
      pending.set(id, {
        finish: (error, result) => {
          clearTimeout(timer);
          error ? reject(error) : resolve(result);
        },
      });
      send(socket, { id, owner, method, params });
    });
  const close = async () => {
    if (closing) return;
    closing = true;
    core.close();
    for (const p of pending.values()) p.finish(Error("Connection closed"));
    pending.clear();
    socket.destroy();
    await web?.close();
    process.stdin.destroy();
  };
  socket.on("error", () => void close());
  socket.on("close", () => void close());
  frames(
    process.stdin,
    (frame) => {
      if (frame.coreResponse && core.pending.has(frame.coreResponse.id))
        core.receive(frame);
      else if (frame.coreResponse) send(socket, frame);
      else throw Error("Unexpected core frame");
    },
    () => void close(),
  );
  process.stdin.on("end", () => void close());
  frames(
    socket,
    async (frame) => {
      if (frame.coreCancel) return send(process.stdout, frame);
      if (frame.coreRequest) {
        try {
          if (!web) throw Error("Web unavailable");
          await web.authorizeActive();
          send(process.stdout, frame);
        } catch {
          send(socket, {
            coreResponse: {
              id: frame.coreRequest.id,
              error: "Owner session unavailable or revoked",
            },
          });
        }
        return;
      }
      if (frame.event) return web?.append(frame.event);
      const p = pending.get(frame.id);
      if (p) {
        pending.delete(frame.id);
        p.finish(frame.error ? Error(frame.error) : null, frame.result);
      }
    },
    () => void close(),
  );
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const auth = new WebAuth({
    origin: options["--origin"],
    botId: options["--bot-id"],
    readOwner: () => core.request("tools.owner", {}, AbortSignal.timeout(3000)),
  });
  try {
    web = await serveWeb({ request, auth, origin: options["--origin"] });
  } catch (error) {
    await close();
    throw error;
  }
  send(process.stdout, {
    web: {
      url:
        options["--origin"] + (auth.localToken ? "/#" + auth.localToken : "/"),
      authentication: auth.local
        ? "one-time local login"
        : "Telegram paired owner",
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void close());
}
