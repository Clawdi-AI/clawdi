# Native embedding CPU ceiling qualification

The owner/root accepted **4 CPU / 4 native threads** to reduce individual request
waits using available cores. CPU quota is a ceiling, not a reservation. Request
capacity stays **1**, memory **4 GiB**, with the same model, single ONNX session,
DB-free worker and identity healthcheck. This candidate awaits final diff review;
it is not a production performance guarantee or authorization to raise admission.

Three alternating paired runs (2/2 then 4/4; 4/4 then 2/2; 2/2 then 4/4) used the
real `LocalEmbedder` worker over UDS, Python 3.14.7 and frozen backend dependencies
at `78da49c019eba70f7233cba2e1972a3ba866326a`. Each fresh container had 4 GiB and
the stated CPU ceiling. Each run measured 48 short multilingual requests and 24
near-limit requests, serially, after warmup. No noisy result was discarded.

| Pair | Workload | 2/2 p50 / p95 ms | 4/4 p50 / p95 ms | CPU/request increase |
| ---: | --- | ---: | ---: | ---: |
| 1 | Short | 40.97 / 50.60 | 33.07 / 38.96 | **63.1%** |
| 1 | Near limit | 651.85 / 683.05 | 349.12 / 367.94 | 7.4% |
| 2 | Short | 47.07 / 57.46 | 30.74 / 41.27 | 34.7% |
| 2 | Near limit | 640.79 / 757.91 | 350.91 / 371.68 | 6.7% |
| 3 | Short | 43.02 / 53.17 | 32.57 / 45.69 | **51.0%** |
| 3 | Near limit | 630.04 / 663.53 | 348.55 / 375.80 | 11.4% |

Long p50 was 54–55% of baseline in every pair; short p50 and both p95s improved.
Aggregate CPU/request increased 48.9% for short and 8.5% for long text. The
advisory <50% CPU-cost target **did not pass in every pair**; acceptance explicitly
includes the short-text exceedances rather than treating that target as passed.

Post-batch first-second CPU was 0.58–0.60 seconds at 2/2 versus 1.71–1.80 at 4/4:
an extra **1.13–1.21 CPU seconds per observed burst tail**, excluded from the timed
CPU/request figures. The next four idle seconds used only 0.01–0.03 CPU seconds
in either configuration, with no idle throttling. Batch-tail measurements are
not isolated-request measurements; do not hide this cost by amortizing it over
the batch. Candidate throttled time was 24–43 ms per short batch and 31–42 ms per
long batch, despite frequent throttled periods. These multi-CPU counters are not
literal wall-clock percentages.

RSS increased less than 0.1% (about 1513 MiB steady, 1909 MiB startup high-water).
All five 768-dimensional vectors matched exactly; tolerance was max absolute
error <1e-5 and cosine >0.999999. The model remains
`sentence-transformers/paraphrase-multilingual-mpnet-base-v2`, FastEmbed 0.8.0 /
ONNX Runtime 1.29.0, supported Xenova revision
`e5d116277351513fd260955ece953ecddde7046e`. Unquantized ONNX SHA-256:
`92f682c55d39e728187c6bffd488f17462d4e05e3c5fe86ef9ba6f38d66122ed`.
The actual tokenizer truncates at 512 tokens; corpus lengths were 19/28/17/17/503.

The benchmark host was a shared 32-vCPU KVM/Xeon Gold 6530, not the deployment
hardware. Synthetic p95s are not SLO estimates. Raw samples, corpus, asset hashes,
collector and logs are retained as separate review artifacts. Any service-level
before/after measurement belongs to the root operator. Handler cancellation can
still release admission before `to_thread` native work finishes; this candidate
does not change or claim to solve that existing ownership limitation.

Validation passed in a disposable `ghcr.io/basecamp/kamal:v2.12.0` container
(2 CPUs / 1 GiB, no host credentials or Docker socket), with Bash installed only
inside that container. Run these existing contracts in that environment:

```bash
scripts/test-kamal-whatsapp-sidecar-render.sh
scripts/test-deploy-backend.sh
scripts/test-deploy-whatsapp-sidecar.sh
```

Done: all three exit 0. Execution was bounded to 180 seconds and the container
was removed. No new tests or inference reruns were added for this candidate.
