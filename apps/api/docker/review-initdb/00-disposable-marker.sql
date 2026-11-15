-- ===========================================================================
-- DISPOSABLE-TEST-SERVER MARKER
--
-- Runs once, on first initialisation of an EMPTY data directory, inside the
-- database named by POSTGRES_DB (kazhal_review).
--
-- The integration harness refuses to run in external mode (KAZHAL_INT_PG_MODE
-- =external) unless it finds this exact marker on the server it was pointed
-- at. That is the "fail closed" gate: pointing the suite at a developer or
-- production PostgreSQL by mistake aborts before a single CREATE DATABASE,
-- because that server was never initialised from this script and therefore
-- carries no marker.
--
-- The marker is deliberately a real table with a fixed token rather than an
-- environment flag: an env var travels with the CLIENT and can be set by
-- accident, whereas this travels with the SERVER and can only exist on a
-- server that was created to be thrown away.
-- ===========================================================================

CREATE TABLE public.kazhal_disposable_test_server (
    token       text        PRIMARY KEY,
    purpose     text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.kazhal_disposable_test_server (token, purpose) VALUES (
    'kazhal-disposable-review-server',
    'Local review/integration PostgreSQL for the kazhal API. Every database on '
    || 'this server is disposable. The integration harness creates one database '
    || 'per run (kazhal_int_<runId>) and drops it on teardown. Never point this '
    || 'marker at a server holding real data.'
);

COMMENT ON DATABASE kazhal_review IS 'kazhal-disposable-review-server';
