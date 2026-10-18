(() => {
  let pendingChoice = null;
  document.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest("[data-mode]");
      if (button && !window.Nen) {
        pendingChoice = button.dataset.mode;
        button.setAttribute("aria-busy", "true");
      }
    },
    true,
  );
  const load = () => {
    const script = document.createElement("script");
    script.src = "app.js";
    script.onload = () => {
      for (const canvas of document.querySelectorAll('canvas')) {
        if (canvas.dataset.renderer !== 'webgl' && canvas.getContext('2d')) canvas.parentElement.classList.add('scene-rendered');
      }
      document
        .querySelectorAll("[data-mode][aria-busy]")
        .forEach((b) => b.removeAttribute("aria-busy"));
      if (pendingChoice)
        document
          .querySelector('.mode-quick [data-mode="' + pendingChoice + '"]')
          ?.click();
    };
    document.body.appendChild(script);
  };
  if (location.protocol === "file:") {
    load();
    return;
  }
  const Legacy = window.BuildScene;
  import("./webgl-scene.js")
    .then(({ WebGLConstructionScene }) => {
      const AdaptiveScene = new Proxy(WebGLConstructionScene, {
        construct(target, args) {
          // A disposed WebGL context cannot be reused when returning home.
          if (args[0].dataset.renderer === 'webgl' && ![...target.instances].some(scene => scene.canvas === args[0])) {
            const fresh = args[0].cloneNode(false);
            fresh.removeAttribute('data-renderer');
            args[0].replaceWith(fresh);
            args[0] = fresh;
            fresh.parentElement.classList.remove('scene-rendered');
          }
          try {
            return Reflect.construct(target, args);
          } catch (error) {
            console.warn("Using the canvas fallback:", error.message);
          const replacement=args[0].cloneNode(false);args[0].replaceWith(replacement);const fallback=new Legacy(replacement,args[1]);replacement.dataset.renderer='canvas';if(fallback.ctx)replacement.parentElement.classList.add('scene-rendered');return fallback;
          }
        },
      });
      window.BuildScene = AdaptiveScene;
      load();
    })
    .catch((error) => {
      console.warn("Using the canvas fallback:", error.message);
      load();
    });
})();
