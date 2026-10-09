-- Enabled up front; vectors themselves are Phase 2.
CREATE EXTENSION IF NOT EXISTS vector;

-- Scratch database for `pnpm test`, which truncates every table it finds and so
-- refuses to run against the app's own. Only new volumes get it from here; an
-- existing one needs the CREATE DATABASE from .env.example by hand. The schema
-- comes from `pnpm db:migrate`, which creates the vector extension itself.
CREATE DATABASE plot_test;
