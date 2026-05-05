"""Split memory content into per-paragraph chunks for retrieval.

Why chunking matters: clawdi-bench 2026-04-29 measured Hit@5 71% on real
data vs gbrain's 97%. Probing showed Clawdi has the right doc in its index
but ranks it below 5 generic "Clawdi"-mentioning docs. Root cause: one
embedding per memory averages the semantic signal across the whole content,
so a query for "clawdi MIGRATION STATUS" can't disambiguate from generic
"Clawdi" mentions in 50 other memories.

gbrain wins this by chunking each page into 5-15 paragraphs and embedding
each chunk separately, then matching at chunk-level. This module ports that
pattern: ~3-8 chunks per memory, paragraph-aligned, never split mid-sentence.

Position 0 is the heading-ish first chunk. The migration tags it with FTS
weight 'A' (others 'B') so exact-title matches dominate.
"""

import re
from dataclasses import dataclass

# Target window: chunks should be informative-enough for embedding to
# capture intent (~too-short → noisy, too-long → semantic dilution).
# Empirically: 300-1500 chars per chunk produces stable 768d embeddings
# on paraphrase-multilingual-mpnet-base-v2.
TARGET_CHUNK_MIN = 300
TARGET_CHUNK_MAX = 1500
# If the full content is below this, single chunk = whole memory. Don't
# fragment short factoids.
SHORT_MEMORY_THRESHOLD = 400


@dataclass(frozen=True)
class Chunk:
    position: int
    content: str


def chunk_memory_content(content: str) -> list[Chunk]:
    """Split memory `content` into ordered chunks.

    Strategy:
    1. Strip a leading H1/H2 heading (`# Title`) and prepend it to the first
       chunk so position 0 is title + intro.
    2. Split at blank-line paragraph boundaries. Each paragraph ≤ TARGET_CHUNK_MAX
       becomes one chunk; longer paragraphs are split at sentence boundaries.
    3. If a chunk falls below TARGET_CHUNK_MIN and the next chunk fits, merge
       them. Avoids dribbling 50-char fragments into the embedding pool.

    Empty / whitespace-only inputs return a single empty chunk so the row
    still satisfies the NOT NULL constraint; callers should normally guard
    against this earlier in the write path.
    """
    text = (content or "").strip()
    if not text:
        return [Chunk(position=0, content="")]

    # Short memory → one chunk. The whole content is the "title" for FTS.
    if len(text) <= SHORT_MEMORY_THRESHOLD:
        return [Chunk(position=0, content=text)]

    # Pull off the first heading line, if any. A heading-as-its-own-chunk
    # is too short to embed meaningfully, so prepend it to chunk 0.
    heading = ""
    body = text
    m = re.match(r"^(#{1,3}\s+[^\n]+)\n+", text)
    if m:
        heading = m.group(1).strip()
        body = text[m.end() :].strip()

    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    if not paragraphs:
        # All-heading memory or weird shape — fall back to whole-content chunk.
        return [Chunk(position=0, content=text)]

    raw_chunks: list[str] = []
    for p in paragraphs:
        if len(p) <= TARGET_CHUNK_MAX:
            raw_chunks.append(p)
            continue
        # Paragraph too long → split at sentence boundaries.
        raw_chunks.extend(_split_long_paragraph(p))

    # Merge adjacent short chunks until each is ≥ TARGET_CHUNK_MIN or the
    # merged size would exceed TARGET_CHUNK_MAX. Operates left-to-right so
    # "title" stays at position 0.
    merged: list[str] = []
    for c in raw_chunks:
        if (
            merged
            and len(merged[-1]) < TARGET_CHUNK_MIN
            and len(merged[-1]) + len(c) + 2 <= TARGET_CHUNK_MAX
        ):
            merged[-1] = merged[-1] + "\n\n" + c
        else:
            merged.append(c)

    # Prepend heading to the first chunk so position-0 carries the title.
    if heading:
        merged[0] = f"{heading}\n\n{merged[0]}"

    return [Chunk(position=i, content=c) for i, c in enumerate(merged)]


def _split_long_paragraph(paragraph: str) -> list[str]:
    """Split a single oversized paragraph at sentence boundaries.

    Sentence boundary heuristic: `. `, `! `, `? `, `\n`. Naive but works for
    English memory text. For markdown lists or code blocks, we accept that
    a chunk may exceed TARGET_CHUNK_MAX rather than split mid-block.
    """
    if "\n" in paragraph and (paragraph.strip().startswith("- ") or "```" in paragraph):
        # List or code block: don't split, return as-is even if oversized.
        return [paragraph]

    sentences = re.split(r"(?<=[.!?])\s+", paragraph)
    chunks: list[str] = []
    current = ""
    for s in sentences:
        if not s.strip():
            continue
        if len(current) + len(s) + 1 <= TARGET_CHUNK_MAX:
            current = (current + " " + s).strip() if current else s
        else:
            if current:
                chunks.append(current)
            current = s
    if current:
        chunks.append(current)
    # Edge case: a single sentence > MAX. Keep as one chunk (better than
    # breaking it mid-thought).
    return chunks or [paragraph]
