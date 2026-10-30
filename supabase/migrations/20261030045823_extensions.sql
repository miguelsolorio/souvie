-- WS00: extensions that later migrations rely on.
-- docs/02-data-model.md §Migration ownership, order 1. No tables, no policies here.

-- gen_random_uuid() is core Postgres; pgcrypto is listed in docs/02 and already present on
-- Supabase. Kept so the dependency is explicit.
create extension if not exists pgcrypto with schema extensions;

-- Trigram matching for ingredient aliases (WS03: gin_trgm_ops index on ingredient_aliases.alias).
create extension if not exists pg_trgm with schema extensions;

-- pgvector for recipe embeddings and HNSW indexes (WS02, WS06).
create extension if not exists vector with schema extensions;

-- Supabase Queues. The worker polls `shopping_run`; the queue itself is created by the WS09
-- runs migration.
create extension if not exists pgmq;

-- Scheduled runs (WS11). pg_cron must be in shared_preload_libraries, which the
-- supabase/postgres image sets by default.
create extension if not exists pg_cron with schema pg_catalog;

-- pgTAP for the RLS policy tests in supabase/tests (`supabase test db`).
create extension if not exists pgtap with schema extensions;
