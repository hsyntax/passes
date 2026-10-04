---
name: Clean up tests
step: 0
model: gpt-6.1-sol
reasoning_effort: high
---

Study all tests and validate that they follow these principles :

- Test behavior through public interfaces.
- Use expected results independent of the implementation.
- Make each test catch a plausible regression.
- Keep tests resilient to internal refactoring.
- For bug fixes, verify the test fails before and passes after.
- Mock external boundaries sparingly.
- Keep tests deterministic and independent.
- Avoid tests that only confirm mocks, constants, or fixtures.
- Prefer meaningful coverage over test count.
- When a useful test is impractical, verify another concrete way.
- Avoid regression tests that validate that a deleted feature or capability that does not come back.

If any test does not follow these rules, update them such that they do follow these rules, then commit.
