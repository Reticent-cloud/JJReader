(() => {
  // src/index.js
  function install(target = {}) {
    const api = { version: "0.1.0" };
    target.JJ = api;
    return api;
  }
  if (typeof window !== "undefined") {
    install(window);
  }
})();
