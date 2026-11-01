// Routes the schedule screens link to and from (WS11). Only an opaque schedule id goes in a URL.
import { NEW_SCHEDULE_ID } from "./logic";

export const SCHEDULES_ROUTE = "/schedules";

export const scheduleRoute = (scheduleId: string) => `${SCHEDULES_ROUTE}/${scheduleId}`;

export const NEW_SCHEDULE_ROUTE = scheduleRoute(NEW_SCHEDULE_ID);
