-- Scratch-only aggregate checks. No row contents or counts leave the container.
SELECT (SELECT count(*) > 0 FROM users)
   AND (SELECT count(*) > 0 FROM agent_environments)
   AND (SELECT count(*) > 0 FROM sessions)
   AND (SELECT max(updated_at) FROM sessions)
       BETWEEN :'target'::timestamptz - make_interval(secs => :max_lag)
           AND :'target'::timestamptz;
