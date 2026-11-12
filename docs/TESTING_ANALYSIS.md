# Voice Counter Command Testing Analysis

## Executive Summary

Extensive testing of the fine-tuned Needle 3 model for voice counter commands revealed **systematic errors** in the interpretation of "decrease" and "reduce" commands, while other commands work correctly.

## Test Results

### ✅ Working Commands (Correct Positive/Negative Semantics)

| Command Pattern | Example | Amount | Status |
|---|---|---|---|
| Add/Plus/Increase | `add 5`, `plus 3`, `increase by 4` | +5, +3, +4 | ✅ |
| Plus sign | `+5` | +5 | ✅ |
| Subtract/Minus/Less/Lower | `subtract 2`, `minus 1`, `less 5`, `lower by 3` | -2, -1, -5, -3 | ✅ |
| Minus sign | `-3` | -3 | ✅ |
| Reset | `reset`, `zero`, `clear` | N/A (reset) | ✅ |
| Compound | `add 5 and then subtract 2` | +5, -2 | ✅ |

### ❌ Broken Commands (Wrong Sign)

| Command Pattern | Example | Expected | Actual | Issue |
|---|---|---|---|---|
| Decrease by | `decrease by 5` | -5 | +5 | Wrong sign |
| Decrease | `decrease 5` | -5 | +5 | Wrong sign |
| Reduce by | `reduce by 5` | -5 | +5 | Wrong sign |
| Reduce | `reduce 5` | -5 | +5 | Wrong sign |
| Take away | `take away 3` | -3 | +3 | Reasoning says reset, but calls modify +3 |

### 🔍 Context Independence Verified

- Each command is processed independently (worker calls `cactus_reset()` before each `cactus_complete()`)
- Previous commands do NOT affect future outputs
- The errors are consistent regardless of command history
- Reset works correctly (returns counter to 0)

## Root Cause Analysis

The model's training data likely contained examples where "decrease by X" and "reduce by X" were mapped to positive amounts, or the model failed to learn the negative semantics for these specific verbs.

**Key observation**: "less 5" and "lower by 3" work correctly (produce -5, -3), but "decrease by 5" and "reduce by 5" don't. This suggests the model learned some negative verbs but not others, despite all being in the same trigger pattern group.

The trigger patterns in `index.html`:
```javascript
triggers: [
  "^(?!.*\\b(and|then|also)\\b).*\\b(add|plus|increase|more|higher|count up)\\b.*\\d+",  // positive
  "^(?!.*\\b(and|then|also)\\b).*\\b(subtract|minus|decrease|less|lower|reduce|take away)\\b.*\\d+",  // negative
]
```

All these verbs share the same trigger pattern, yet the model behaves differently for each.

## Updated Training Data

Created `training-data-fixes.jsonl` with 38 corrected training examples covering:

- **Negative commands** (should produce negative amounts):
  - `decrease by X`, `decrease X` (multiple values)
  - `reduce by X`, `reduce X` (multiple values)
  - `take away X`
  - `subtract X`, `minus X`, `less X`, `lower by X` (already working, reinforced)

- **Positive commands** (should produce positive amounts):
  - `add X`, `plus X`, `increase by X`, `+X` (already working, reinforced)

- **Compound commands**:
  - `add 5 and then subtract 2`
  - `add 3 and subtract 1`
  - `increase by 5 then decrease by 2`

- **Word numbers**:
  - `add five`, `subtract three`, `plus two`, `minus one`

- **Reset commands**:
  - `reset`, `zero`, `clear`

## Recommendations for Re-training

1. **Use the provided training data** (`training-data-fixes.jsonl`) to fine-tune the Needle model
2. **Focus on negative verb examples** - include 3-5x more negative examples than positive to correct the bias
3. **Include compound commands** to ensure the model handles multiple operations correctly
4. **Test with word numbers** to ensure robustness
5. **Verify context independence** after re-training by running the same test sequence

## Testing Protocol for Validation

After re-training, verify these specific cases:
1. `decrease by 5` → amount: -5.0
2. `decrease 3` → amount: -3.0
3. `reduce by 5` → amount: -5.0
4. `reduce 3` → amount: -3.0
5. `take away 2` → amount: -2.0 (not reset)
6. `less 4` → amount: -4.0 (should still work)
7. `lower by 3` → amount: -3.0 (should still work)
8. `subtract 2` → amount: -2.0 (should still work)
9. `add 5 and then subtract 2` → amounts: +5.0, -2.0
10. Reset still works: `reset` → reset tool called

## Files Created

- `training-data-fixes.jsonl` - 38 corrected training examples in JSONL format
- `TESTING_ANALYSIS.md` - This analysis document