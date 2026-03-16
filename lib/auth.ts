import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          // Scopes necesarios:
          // - Drive: copiar/exportar/borrar archivos de Slides
          // - Presentations: reemplazar texto en la plantilla
          // - Gmail send: enviar emails desde la cuenta del usuario (sin contraseña de app)
          scope: [
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/presentations",
            "https://www.googleapis.com/auth/gmail.send",
          ].join(" "),
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      // Primera vez que se inicia sesión: guardar tokens de Google
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at;
      }

      // Si el token no ha expirado, usarlo tal cual
      if (token.expiresAt && Date.now() < token.expiresAt * 1000 - 60_000) {
        return token;
      }

      // Token expirado: intentar refrescarlo
      if (!token.refreshToken) {
        return { ...token, error: "RefreshTokenMissing" };
      }

      try {
        const response = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID!,
            client_secret: process.env.GOOGLE_CLIENT_SECRET!,
            grant_type: "refresh_token",
            refresh_token: token.refreshToken,
          }),
        });

        const refreshed = await response.json();
        if (!response.ok) throw refreshed;

        return {
          ...token,
          accessToken: refreshed.access_token,
          expiresAt: Math.floor(Date.now() / 1000) + refreshed.expires_in,
          refreshToken: refreshed.refresh_token ?? token.refreshToken,
          error: undefined,
        };
      } catch {
        return { ...token, error: "RefreshTokenError" };
      }
    },

    async session({ session, token }) {
      session.accessToken = token.accessToken;
      session.refreshToken = token.refreshToken;
      session.error = token.error;
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
};
