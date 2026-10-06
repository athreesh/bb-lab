// bb-plugin-ceo-interaction — server entry.
//
// This plugin is instructional: it contributes agent skills (see skills/) and
// registers no RPC, CLI, storage, or services. The factory returns no
// disposer because there is nothing to clean up.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded (instructional plugin; skills auto-injected)");
}
