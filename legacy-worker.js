// This app is served at the origin root and no longer uses a Service Worker.
// Leave registrations for other paths and all Cache Storage data untouched.
export async function removeLegacyWorker(serviceWorker, baseUrl) {
  if (!serviceWorker) return false;
  const scope = new URL("./", baseUrl).href;
  const controllerUrl = serviceWorker.controller?.scriptURL;
  let reload = false;
  for (const registration of await serviceWorker.getRegistrations()) {
    if (registration.scope !== scope) continue;
    const controlsPage = controllerUrl && registration.active?.scriptURL === controllerUrl;
    const removed = await registration.unregister();
    reload ||= Boolean(removed && controlsPage);
  }
  return reload;
}
