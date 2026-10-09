// Answers the shizue web app's presence check. Sign-in itself needs no code here:
// rules.json rewrites OpenAI's loopback callback to the app before any connection
// is opened, and the app's server checks the result.
chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  if (message?.type === 'ping') reply({ ok: true, version: chrome.runtime.getManifest().version });
});
