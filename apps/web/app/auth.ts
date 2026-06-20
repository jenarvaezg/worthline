import NextAuth from "next-auth";

import config from "@web/auth.config";

export const { handlers, signIn, signOut, auth } = NextAuth(config);
