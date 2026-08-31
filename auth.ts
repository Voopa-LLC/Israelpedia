// auth.ts
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "./db";
import { users, accounts, sessions, verificationTokens } from "./db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

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
  // Credentials provider requires JWT sessions — database sessions are not supported for credentials auth.
  // The adapter still manages users and OAuth accounts in the DB; only the session itself is a JWT cookie.
  session: { strategy: "jwt" },
  providers: [
    Google({ allowDangerousEmailAccountLinking: true }),
    Credentials({
      async authorize(credentials) {
        const email = credentials.email as string;
        const password = credentials.password as string;
        if (!email || !password) return null;
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, email.toLowerCase()));
        if (!user || !user.hashedPassword) return null;
        const valid = await bcrypt.compare(password, user.hashedPassword);
        if (!valid) return null;
        return { id: user.id, email: user.email, name: user.name, image: user.image };
      },
    }),
  ],
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
