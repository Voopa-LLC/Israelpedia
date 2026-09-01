// auth.ts
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "./db";
import { users, accounts, sessions, verificationTokens } from "./db/schema";
import { eq } from "drizzle-orm";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  // Auth.js only trusts the request's Host header when it detects Vercel, when
  // NODE_ENV is not "production", or when told to. So a LOCAL production build
  // (`npm run build && npm start`) failed every /api/auth/* route with
  // UntrustedHost. Setting it here rather than in .env keeps the fix in the
  // repo instead of on one machine. No change on Vercel, which already trusts
  // the host automatically.
  trustHost: true,
  // JWT sessions rather than database sessions. Google is now the only provider,
  // so a database strategy would work too, but switching would invalidate every
  // signed-in cookie and move the role lookup off the token — no reason to.
  // The adapter still manages users and OAuth accounts in the DB.
  session: { strategy: "jwt" },
  // Google is the only way in. Email + password was removed on 2026-09-01; the
  // `hashed_password` column and `password_reset_tokens` table are kept in the
  // schema so bringing it back does not mean rebuilding it.
  providers: [Google({ allowDangerousEmailAccountLinking: true })],
  pages: {
    signIn: "/signin",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        // Persist id and role into the token on first sign-in
        token.id = user.id;
        const [dbUser] = await db
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, user.id));
        token.role = dbUser?.role ?? "reader";
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token) {
        session.user.id = token.id as string;
        (session.user as any).role = token.role;
      }
      return session;
    },
  },
});
