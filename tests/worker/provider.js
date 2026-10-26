export default {
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/redirect"))
      return Response.redirect("https://untrusted.test", 302);
    if (path.endsWith("/missing"))
      return new Response("not found", { status: 404 });
    if (request.headers.get("authorization") !== "Bearer fixture-token")
      return new Response("invalid token", { status: 401 });
    return Response.json({ id: "fixture-org", plan: "free" });
  },
};
