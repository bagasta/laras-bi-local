import { createApp } from "./app.js";
import assets from "sites:assets";
import first from "../supabase/migrations/001_laras.sql";
import second from "../supabase/migrations/002_multi_documents.sql";
import third from "../supabase/migrations/003_office_documents.sql";
export default createApp({
  assets,
  migration: first + "\n" + second + "\n" + third,
  instanceId: "laras-local",
});
