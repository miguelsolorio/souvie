/** The signed-in landing route. WS04 will point this at /plan once the planner exists. */
export const HOME_ROUTE = "/";

export const SIGN_IN_ROUTE = "/sign-in";
export const CREATE_HOUSEHOLD_ROUTE = "/household/create";

export const joinRoute = (token: string) => `/join/${token}`;
