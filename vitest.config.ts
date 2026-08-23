import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /**
     * Renderer components have no tests — their correctness rides on the shared
     * modules they delegate to. `src/renderer/src/stores` is the exception:
     * a store holds *lifecycle* state that no shared module can reach, so
     * nothing else can cover it.
     */
    include: ['src/shared/**/*.test.ts', 'src/main/**/*.test.ts', 'src/renderer/src/stores/**/*.test.ts'],
    /**
     * One test file at a time. Several suites (`build-service`, `examples`,
     * `game-kit-build`, `project`) drive **one** MSXgl checkout, whose compile
     * step is not reentrant: it writes each `.rel` inside the engine directory
     * and renames it into the project's `out/`, so two builds running at once
     * take each other's object files. Serialising the files also keeps the
     * real-git suites from timing out while a compile saturates the machine.
     */
    fileParallelism: false
  }
})
