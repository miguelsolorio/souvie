// Wires the list replay queue (@mp/db) to this app: where its saved writes live, and what to say
// when the server refuses one. Importing this module is the whole call; the list hooks and
// ListSyncLifecycle import it, so it runs before the first queue is made.
import { configureReplayStorage, listErrorMessage, setListWriteFailureHandler } from "@mp/db";
import { kvStorage } from "../../lib/storage";
import { showPlanNotice } from "../plan/notice";

configureReplayStorage(kvStorage);

setListWriteFailureHandler((op, error) => {
  const what =
    op.kind === "check"
      ? "That check-off"
      : op.kind === "add"
        ? "That new item"
        : op.kind === "remove"
          ? "That removal"
          : "That change";
  showPlanNotice(`${what} was not saved. ${listErrorMessage(error)}`);
});
