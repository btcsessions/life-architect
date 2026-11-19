// Present so phones offer "Install app". It does no caching: the deck always loads fresh from the Umbrel.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
