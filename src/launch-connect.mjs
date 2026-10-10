import { CoreTools } from './plugin-tools.mjs';
import { frames, send } from './protocol.mjs';
import { LaunchLinks } from './launch-links.mjs';

export async function launchConnect(state) {
  const core = new CoreTools(process.stdout);
  frames(process.stdin, frame => core.receive(frame), () => core.close());
  try {
    const owner = await core.request('tools.owner', {}, AbortSignal.timeout(3000));
    const launch = await new LaunchLinks(state).issue(owner);
    send(process.stdout, { launch });
  } finally { core.close(); process.stdin.destroy(); }
}
