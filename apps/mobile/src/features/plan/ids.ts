// Gives @mp/db a proper random source for the ids the planner picks on the device (new entries,
// new plans, thumbs). Importing this module is the whole call; the planner hooks import it.
import { setIdGenerator } from "@mp/db";
import * as Crypto from "expo-crypto";

setIdGenerator(() => Crypto.randomUUID());
