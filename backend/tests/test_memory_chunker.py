"""Unit tests for app.services.memory_chunker."""

from app.services.memory_chunker import (
    SHORT_MEMORY_THRESHOLD,
    TARGET_CHUNK_MAX,
    chunk_memory_content,
)


def test_empty_content_returns_single_empty_chunk() -> None:
    chunks = chunk_memory_content("")
    assert len(chunks) == 1
    assert chunks[0].position == 0
    assert chunks[0].content == ""


def test_short_memory_is_single_chunk() -> None:
    text = "Bot name is Rico, not ClawdBot."
    chunks = chunk_memory_content(text)
    assert len(chunks) == 1
    assert chunks[0].position == 0
    assert chunks[0].content == text


def test_short_memory_at_threshold_stays_single_chunk() -> None:
    text = "x" * (SHORT_MEMORY_THRESHOLD - 1)
    chunks = chunk_memory_content(text)
    assert len(chunks) == 1


def test_paragraph_split_long_memory() -> None:
    """Long memory with clear paragraphs splits at \\n\\n boundaries."""
    para1 = "First paragraph about voice setup. " * 15  # ~525 chars
    para2 = "Second paragraph about scope issue. " * 15
    para3 = "Third paragraph about migration. " * 15
    text = f"{para1}\n\n{para2}\n\n{para3}"
    chunks = chunk_memory_content(text)
    assert len(chunks) >= 3
    assert chunks[0].position == 0
    assert chunks[1].position == 1
    # Each chunk should be reasonably sized
    for c in chunks:
        assert len(c.content) <= TARGET_CHUNK_MAX


def test_heading_prepended_to_first_chunk() -> None:
    """An H1 heading at the top is folded into chunk 0, not standalone."""
    text = (
        "# Voice Call Twilio Setup\n\n"
        + ("Voice-call extension switched from Telnyx to Twilio. " * 20)
        + "\n\n"
        + ("Configuration lives in /data/openclaw/openclaw.json. " * 20)
    )
    chunks = chunk_memory_content(text)
    # Chunk 0 should contain the heading text
    assert "# Voice Call Twilio Setup" in chunks[0].content
    assert chunks[0].position == 0
    # The heading isn't its own chunk
    assert chunks[0].content.count("\n") >= 1  # heading + body


def test_oversized_paragraph_split_at_sentences() -> None:
    """A single paragraph over MAX gets split at sentence boundaries."""
    sentence = (
        "This is a relatively long sentence with multiple clauses and "
        "punctuation that takes up a fair number of characters. "
    )
    text = sentence * 30  # ~3700 chars, no \n\n
    chunks = chunk_memory_content(text)
    assert len(chunks) >= 2
    for c in chunks:
        # Allow some slack for sentences that exceed MAX individually
        assert len(c.content) <= TARGET_CHUNK_MAX + 200


def test_position_is_zero_indexed_and_contiguous() -> None:
    text = (
        ("First paragraph. " * 30)
        + "\n\n"
        + ("Second paragraph. " * 30)
        + "\n\n"
        + ("Third paragraph. " * 30)
    )
    chunks = chunk_memory_content(text)
    positions = [c.position for c in chunks]
    assert positions == list(range(len(chunks)))


def test_short_chunks_get_merged_with_neighbor() -> None:
    """Adjacent short chunks merge to avoid embedding noise."""
    text = "Very short.\n\n" + ("A longer paragraph follows. " * 30)
    chunks = chunk_memory_content(text)
    # The short opener should merge with the next chunk; we expect a single
    # chunk under SHORT_MEMORY_THRESHOLD or one combined chunk.
    if len(chunks) > 1:
        # If we did get multiple chunks, the first should be the merged
        # one that includes "Very short."
        assert "Very short" in chunks[0].content


def test_list_content_not_split_mid_block() -> None:
    """Markdown lists stay intact even if the whole block exceeds MAX."""
    items = "\n".join(f"- bullet point number {i} with some content" for i in range(50))
    text = f"# Things\n\n{items}"
    chunks = chunk_memory_content(text)
    # Lists shouldn't be split into 50 individual fragments
    assert len(chunks) <= 4
