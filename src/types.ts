import { auth } from "./auth";

export interface HonoEnv {
  Bindings: CloudflareBindings;
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
}
