// Run as a child process by abuse.test.ts: a server whose rooms take a while to load, like one
// whose database is waking up. Reports its port to the parent.
import type { AddressInfo } from "node:net";
import { createCollabServer } from "../src/server";
import { MemoryStore } from "../src/store";
import { SECRET } from "./helpers";

class SlowStore extends MemoryStore {
  override async load(roomId: string) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return super.load(roomId);
  }
}

const { server } = createCollabServer({ tokenSecret: SECRET, store: new SlowStore() });
server.listen(0, "127.0.0.1", () => process.send?.((server.address() as AddressInfo).port));
