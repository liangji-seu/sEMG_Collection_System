"""Small, shared counter checks for offline alignment and timestamp repair."""

import numpy as np

U32_MODULUS = 1 << 32


def counter_transition(previous, current):
    """Classify a raw u32 transition without treating arbitrary resets as wraps.

    A wrap is accepted only in the last/first 65536 counts of the u32 range.
    Larger ambiguous jumps need source/segment evidence and are rejected.
    """
    previous, current = int(previous), int(current)
    if not (0 <= previous < U32_MODULUS and 0 <= current < U32_MODULUS):
        return 'invalid'
    if current == previous:
        return 'duplicate'
    if current > previous:
        return 'forward'
    if previous >= U32_MODULUS - 65536 and current < 65536:
        return 'wrap'
    return 'reset_or_reorder'


def unwrap_u32_strict(frame_ids):
    """Unwrap proven boundary wraps; reject duplicates/resets instead of guessing."""
    raw = np.asarray(frame_ids)
    if raw.ndim != 1 or not np.issubdtype(raw.dtype, np.integer):
        raise ValueError('frame_ids must be a one-dimensional integer array')
    if np.any(raw < 0) or np.any(raw >= U32_MODULUS):
        raise ValueError('frame_ids must be raw u32 counters')
    result = raw.astype(np.int64).copy()
    offset = 0
    for i in range(1, len(raw)):
        kind = counter_transition(raw[i - 1], raw[i])
        if kind == 'wrap':
            offset += U32_MODULUS
        elif kind != 'forward':
            raise ValueError(f'{kind} at row {i}: {int(raw[i-1])} -> {int(raw[i])}; explicit segment evidence required')
        result[i] += offset
    return result
