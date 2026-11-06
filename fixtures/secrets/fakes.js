// The one list of fake secrets the secret-redaction fixtures show (test/secrets*.test.js reads it too). Every value is
// made up and marked FAKE where its format allows, and each is assembled from pieces at run time, so no complete
// key-shaped string sits in the repository for a secret scanner to flag. Classic script: pages load it with <script>,
// tests evaluate it with node:vm.
(function () {
  const join = (...parts) => parts.join('');
  const pemLines = [
    join('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQCFAKE0dQ1x2Y3z'),
    join('4Zb5Yc6Xd7We8Vf9Ug0Th1Si2Rj3Qk4P', 'l5Om6Nn7Mo8Lp9Kq0Jr1Is2Ht3Gu4FAKE'),
    join('Fv5Ew6Dx7Cy8Bz9Aa0Zb1Yc2Xd3We4Vf', '5Ug6Th7Si8Rj9Qk0Pl1Om2Nn3Mo4Lp5=='),
  ];
  const fakes = {
    openai: join('sk-', 'proj-', 'FAKEab12Cd34Ef56Gh78', 'Ij90Kl12Mn34Op56Qr78St90Uv12Wx34Yz56'),
    openaiLegacy: join('sk-', 'FAKEiframe0123456789', 'abcdefABCDEF0123'),
    anthropic: join('sk-', 'ant-', 'api03-', 'FAKEx9Y8w7V6u5T4s3R2', 'q1P0o9N8m7L6k5J4i3H2g1F0e9D8c7B6a5'),
    github: join('gh', 'p_', 'FAKE0123456789abcdefghij', 'ABCDEFGHIJkl'),
    githubShadow: join('gh', 'p_', 'FAKEshadow0123456789ab', 'cdefghijKLMNOP'),
    githubPat: join('github', '_pat_', '11FAKE0000_abcdefghij', 'klmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRS'),
    slack: join('xo', 'xb-', '0000FAKE0000-0000000000000-', 'abcdefghijklmnopqrstuvwx'),
    slackWebhook: join('https://hooks.slack.com/', 'services/', 'T00FAKE00/B00FAKE00/', 'abcdefghij1234567890wxyz'),
    awsId: join('AK', 'IA', 'FAKE', 'IOSFODNN7EXA'),
    awsSecret: join('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYFAKE000KEY'),
    google: join('AI', 'za', 'SyFAKE', '0123456789abcdefghijklmnopqrs'),
    googleOauth: join('ya', '29.', 'FAKE0a1b2c3d4e5f6g7h8i9j', 'Kk_Ll-Mm0Nn1'),
    stripe: join('sk', '_live_', 'FAKE51Hx0000abcdef', 'ABCDEF1234'),
    stripeWebhook: join('wh', 'sec_', 'FAKEabcdefghij0123', '456789ABCD'),
    npm: join('np', 'm_', 'FAKE0123456789abcdefghij', 'ABCDEFGHIJkl'),
    huggingface: join('h', 'f_', 'FAKEabcdefghij0123456789', 'ABCDEFGHIJ'),
    xai: join('xa', 'i-', 'FAKE0123456789abcdefghij', 'ABCDEFGHIJklmnopqrstuv'),
    gitlab: join('gl', 'pat-', 'FAKE0123456789', 'abcdefgh'),
    jwt: join('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiJGQUtFMTIzNCJ9', '.', 'FAKEsig0123456789abcdefgh'),
    // No known format: found by the generic rule next to "API key".
    genericKey: join('Zx9FAKEq8W7e6R5', 't4Y3u2I1o0'),
    // Environment variables: a DSN password and a session secret without a known format.
    dbPassword: join('Pa55', 'FAKE', 'w0rd'),
    sessionSecret: join('FAKE7d9c3b1a', '0e2f4g6h8j'),
    card: join('4242 4242', ' 4242 4242'),
    totp: join('JBSW Y3DP ', 'EHPK 3PXP ', 'FAKE 2345'),
    recovery: [join('a1b2c', '-3d4e5'), join('f6a7b', '-8c9d0'), join('b2c3d', '-4e5f6'), join('c7d8e', '-9f0a1')],
    password: join('hunter2', 'FAKEpass!'),
    pemLines,
    pem: ['-----BEGIN PRIVATE KEY-----', ...pemLines, '-----END PRIVATE KEY-----'].join('\n'),
  };
  fakes.dbUrl = join('postgres://app:', fakes.dbPassword, '@db.example.internal:5432/app');
  globalThis.FAKE_SECRETS = fakes;
})();
