using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "transport", worker = (
      compatibilityDate = "2026-10-01",
      modules = [
        (name = "test.js", esModule = embed "transport.js"),
        (name = "server/http.js", esModule = embed "../../server/http.js"),
        (name = "server/config.js", esModule = embed "../../server/config.js"),
        (name = "server/infrastructure/upstream.js", esModule = embed "../../server/infrastructure/upstream.js"),
        (name = "server/infrastructure/supabase.js", esModule = embed "../../server/infrastructure/supabase.js")
      ],
      bindings = [(name = "PROVIDER", service = "provider")]
    )),
    (name = "provider", worker = (
      compatibilityDate = "2026-10-01",
      modules = [(name = "mock.js", esModule = embed "provider.js")]
    ))
  ]
);
