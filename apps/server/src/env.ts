export function readEnv(env: NodeJS.ProcessEnv) {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Missing required env var ${k}`);
    return v;
  };
  return {
    databaseUrl: need('DATABASE_URL'),
    port: Number(env.PORT ?? 8787),
    botInfoUrl: need('BOT_INFO_URL'),
    clientIpHeader: env.CLIENT_IP_HEADER || undefined,
  };
}
