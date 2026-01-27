#!/bin/bash

# Sprint Completion Check Script
# Usage: ./scripts/check-sprint-completion.sh <sprint_number>

SPRINT=$1

if [ -z "$SPRINT" ]; then
    echo "Usage: ./scripts/check-sprint-completion.sh <sprint_number>"
    exit 1
fi

echo "=== Checking Sprint $SPRINT Completion ==="
echo ""

FAILED=0

# Expected screenshots per sprint
declare -A EXPECTED_SCREENSHOTS=(
    [1]=13 [2]=17 [3]=11 [4]=19 [5]=13 [6]=11 [7]=8 [8]=12
    [9]=8 [10]=7 [11]=8 [12]=8 [13]=10 [14]=10 [15]=10 [16]=9
    [17]=11 [18]=12 [19]=14 [20]=11 [21]=13 [22]=8 [23]=8 [24]=10
    [25]=8 [26]=5 [27]=6 [28]=7
)

# 1. Check Unit Tests
echo "1. Checking Unit Tests..."
npm run test:unit > /tmp/unit-test-output.txt 2>&1
if [ $? -eq 0 ]; then
    echo "   [PASS] Unit tests passed"
else
    echo "   [FAIL] Unit tests failed"
    FAILED=1
fi

# 2. Check Integration Tests
echo "2. Checking Integration Tests..."
npm run test:integration > /tmp/integration-test-output.txt 2>&1
if [ $? -eq 0 ]; then
    echo "   [PASS] Integration tests passed"
else
    echo "   [FAIL] Integration tests failed"
    FAILED=1
fi

# 3. Check Screenshots
echo "3. Checking Screenshots..."
EXPECTED=${EXPECTED_SCREENSHOTS[$SPRINT]:-10}
ACTUAL=$(ls screenshots/s${SPRINT}-*.png 2>/dev/null | wc -l | tr -d ' ')
if [ "$ACTUAL" -ge "$EXPECTED" ]; then
    echo "   [PASS] Screenshots: $ACTUAL/$EXPECTED"
else
    echo "   [FAIL] Screenshots: $ACTUAL/$EXPECTED (missing $(($EXPECTED - $ACTUAL)))"
    FAILED=1
fi

# 4. Check Build
echo "4. Checking Build..."
npm run build > /tmp/build-output.txt 2>&1
if [ $? -eq 0 ]; then
    echo "   [PASS] Build succeeded"
else
    echo "   [FAIL] Build failed"
    FAILED=1
fi

# 5. Check TypeScript
echo "5. Checking TypeScript..."
npx tsc --noEmit > /tmp/tsc-output.txt 2>&1
if [ $? -eq 0 ]; then
    echo "   [PASS] TypeScript check passed"
else
    echo "   [FAIL] TypeScript errors found"
    FAILED=1
fi

# 6. Check Lint
echo "6. Checking Lint..."
npm run lint > /tmp/lint-output.txt 2>&1
if [ $? -eq 0 ]; then
    echo "   [PASS] Lint passed"
else
    echo "   [FAIL] Lint errors found"
    FAILED=1
fi

# 7. Check Console Errors (via Playwright)
echo "7. Checking Console Errors..."
npx playwright test tests/e2e/console-check.spec.ts --reporter=line > /tmp/console-check.txt 2>&1
if [ $? -eq 0 ]; then
    echo "   [PASS] No console errors"
else
    echo "   [WARN] Console check skipped or failed"
fi

# 8. Check Artifacts
echo "8. Checking Artifacts..."
ARTIFACTS_DIR="logs"
if [ -d "$ARTIFACTS_DIR" ] && [ "$(ls -A $ARTIFACTS_DIR/s${SPRINT}-*.json 2>/dev/null)" ]; then
    echo "   [PASS] Log artifacts exist"
else
    echo "   [WARN] Log artifacts may be missing"
fi

echo ""
echo "=== Summary ==="

if [ $FAILED -eq 0 ]; then
    echo "Sprint $SPRINT COMPLETED successfully!"
    echo "Ready to proceed to Sprint $((SPRINT + 1))"
    exit 0
else
    echo "Sprint $SPRINT NOT COMPLETED - fix failures above"
    exit 1
fi
