FROM supabase/edge-runtime:v1.74.2

COPY index.ts deno.json /srv/functions-loader/
COPY _shared/ /srv/functions-loader/_shared/

CMD ["start", "--main-service", "/srv/functions-loader"]