# Renderer Surface Audit -- WebGL API Call Sites

Phase 0 audit for the WebGPU migration. Every point where Sombra touches the
WebGL2 API, organized by **logical operation**. For each call site we record:
file path and line range, WebGL calls used, what the operation does, and how
often it fires at runtime.

---

## Table of Contents

1. [Context Acquisition](#1-context-acquisition)
2. [Fullscreen Quad Geometry](#2-fullscreen-quad-geometry)
3. [GPU Capability Detection](#3-gpu-capability-detection)
4. [Context Loss / Restore](#4-context-loss--restore)
5. [Shader Compilation](#5-shader-compilation)
6. [Program Linking](#6-program-linking)
7. [Program Cache Management](#7-program-cache-management)
8. [Uniform Introspection (Reflection)](#8-uniform-introspection-reflection)
9. [Uniform Upload](#9-uniform-upload)
10. [Framebuffer Object Management](#10-framebuffer-object-management)
11. [Texture Management](#11-texture-management)
12. [Texture Binding and Sampling](#12-texture-binding-and-sampling)
13. [Single-Pass Rendering](#13-single-pass-rendering)
14. [Multi-Pass Rendering](#14-multi-pass-rendering)
15. [Preview Single-Pass Rendering](#15-preview-single-pass-rendering)
16. [Preview Multi-Pass Rendering](#16-preview-multi-pass-rendering)
17. [GPU Readback](#17-gpu-readback)
18. [Screen Clear](#18-screen-clear)
19. [Resource Teardown](#19-resource-teardown)
20. [Extensions](#20-extensions)
21. [Multi-Pass Architecture Deep Dive](#21-multi-pass-architecture-deep-dive)
22. [State Persistence Analysis](#22-state-persistence-analysis)
23. [Summary Table of Unique WebGL API Calls](#23-summary-table-of-unique-webgl-api-calls)

---

## 1. Context Acquisition

| | |
|---|---|
| **Description** | Obtain a WebGL2 rendering context from a canvas element. |
| **Call sites** | `src/webgl/renderer.ts:126` (visible canvas), `src/webgl/preview-renderer.ts:44` (OffscreenCanvas) |
| **WebGL calls** | `canvas.getContext('webgl2')` |
| **Frequency** | Once per renderer lifetime. Two contexts total at app startup (main + preview). |

The main renderer uses the DOM `<canvas>` that gets reparented between
dock/float/fullwindow targets. The preview renderer creates its own
`OffscreenCanvas(80, 80)` for off-DOM thumbnail capture.

---

## 2. Fullscreen Quad Geometry

| | |
|---|---|
| **Description** | Create a VAO with a single VBO containing 6 vertices (2 triangles) covering clip space [-1, 1]. This is the only geometry in the entire application. |
| **Call sites** | `src/webgl/renderer.ts:146-164`, `src/webgl/preview-renderer.ts:49-59` |
| **WebGL calls** | `createVertexArray`, `bindVertexArray`, `createBuffer`, `bindBuffer(ARRAY_BUFFER)`, `bufferData(ARRAY_BUFFER, ..., STATIC_DRAW)`, `enableVertexAttribArray(0)`, `vertexAttribPointer(0, 2, FLOAT, false, 0, 0)`, `bindVertexArray(null)` |
| **Frequency** | Once at init. Repeated on context restore (main renderer only). |

Both renderers create identical quad geometry. The vertex data is a
`Float32Array` of 12 floats (6 vertices x 2 components): two triangles
spanning `(-1,-1)` to `(1,1)`. Attribute location 0 is hardcoded for
`a_position`.

---

## 3. GPU Capability Detection

| | |
|---|---|
| **Description** | Query device limits and renderer identity for diagnostics and adaptive quality. |
| **Call sites** | `src/webgl/renderer.ts:167-188` |
| **WebGL calls** | `getParameter(MAX_TEXTURE_SIZE)`, `getParameter(MAX_TEXTURE_IMAGE_UNITS)`, `getParameter(RENDERER)`, `getExtension('KHR_parallel_shader_compile')` |
| **Frequency** | Once at init. Repeated on context restore. |

Results are stored on the renderer instance. The `RENDERER` string is used
for diagnostics. `KHR_parallel_shader_compile` availability gates async
compile polling (see [Extensions](#20-extensions)).

---

## 4. Context Loss / Restore

| | |
|---|---|
| **Description** | Handle `webglcontextlost` and `webglcontextrestored` events. On loss, null out all GL object references. On restore, re-initialize quad, caps, and shader. |
| **Call sites** | `src/webgl/renderer.ts:191-212` |
| **WebGL calls** | None directly -- event listeners on the canvas element. Restore path calls `initQuad()`, `detectGPUCaps()`, `updateShader()`. |
| **Frequency** | Rare. Triggered by OS resource pressure or GPU driver reset. |

Several methods guard against lost context with `gl.isContextLost()` checks
before proceeding (lines 385, 415, 760).

---

## 5. Shader Compilation

| | |
|---|---|
| **Description** | Compile a single GLSL shader (vertex or fragment) from source text. |
| **Call sites** | `src/webgl/renderer.ts:218-230`, `src/webgl/preview-renderer.ts:63` |
| **WebGL calls** | `createShader(type)`, `shaderSource(shader, source)`, `compileShader(shader)`, `getShaderParameter(shader, COMPILE_STATUS)`, `getShaderInfoLog(shader)`, `deleteShader(shader)` (on failure only) |
| **Frequency** | Once per shader source change. The vertex shader is compiled once (never changes). Fragment shaders recompile on every graph edit that reaches the compiler. Preview renderer compiles its vertex shader once at init (line 63). |

The main renderer's `createShader` is a private helper called by
`compileProgram`. Error info logs are captured for user-facing diagnostics
before the failed shader object is deleted.

---

## 6. Program Linking

| | |
|---|---|
| **Description** | Link a vertex + fragment shader pair into a GPU program. Binds attribute location 0 before linking. |
| **Call sites** | `src/webgl/renderer.ts:232-262` |
| **WebGL calls** | `createProgram`, `attachShader(prog, vs)`, `attachShader(prog, fs)`, `bindAttribLocation(prog, 0, 'a_position')`, `linkProgram(prog)`, `getProgramParameter(prog, LINK_STATUS)`, `getProgramInfoLog(prog)`, `deleteShader(vs)`, `deleteShader(fs)`, `deleteProgram(prog)` (on failure) |
| **Frequency** | Once per distinct fragment shader source. Results are cached (see below). |

On successful link, both shader objects are deleted immediately (lines
253-254) since they are no longer needed. On failure, all three objects
(vs, fs, program) are cleaned up (lines 257-259).

---

## 7. Program Cache Management

| | |
|---|---|
| **Description** | LRU cache of compiled programs keyed by fragment shader source. Avoids recompiling previously seen shaders. |
| **Call sites** | `src/webgl/renderer.ts:265-296` (main, max 32 entries), `src/webgl/preview-renderer.ts:95-113` (preview, max 64 entries) |
| **WebGL calls** | `deleteProgram(evicted.program)` on cache eviction |
| **Frequency** | Eviction happens when cache exceeds capacity (32 main, 64 preview). Typical usage stays well within limits. |

The main renderer caches programs in `getOrCompileProgram` (line 265). The
preview renderer maintains its own separate cache within `renderPreview`
(line 95) and `renderMultiPassPreview` (line 245).

---

## 8. Uniform Introspection (Reflection)

| | |
|---|---|
| **Description** | After linking, enumerate all active uniforms and cache their locations for fast per-frame upload. |
| **Call sites** | `src/webgl/renderer.ts:299-311` |
| **WebGL calls** | `getProgramParameter(program, ACTIVE_UNIFORMS)`, `getActiveUniform(program, i)`, `getUniformLocation(program, name)` |
| **Frequency** | Once per newly compiled program. Results stored in a `Map<string, WebGLUniformLocation>`. |

The preview renderer does not pre-cache uniform locations -- it calls
`getUniformLocation` inline during each render call (see sections 15-16).

---

## 9. Uniform Upload

| | |
|---|---|
| **Description** | Set uniform values on the active program. Covers both built-in uniforms (time, resolution, DPR, ref size, viewport) and user-defined uniforms from node parameters. |
| **Call sites** | |
| -- Built-in (main) | `src/webgl/renderer.ts:880-898` |
| -- User (main, single-pass) | `src/webgl/renderer.ts:588-598` |
| -- User (main, multi-pass) | `src/webgl/renderer.ts:600-624` |
| -- Upload helper | `src/webgl/renderer.ts:640-648` |
| -- Built-in (preview) | `src/webgl/preview-renderer.ts:119-135`, `275-284` |
| -- User (preview) | `src/webgl/preview-renderer.ts:138-149`, `287-294` |
| **WebGL calls** | `useProgram(program)`, `uniform1f(loc, v)`, `uniform2f(loc, v0, v1)`, `uniform3f(loc, v0, v1, v2)`, `uniform4f(loc, v0, v1, v2, v3)`, `getUniformLocation(program, name)` (preview only, inline) |
| **Frequency** | Every frame for built-ins. User uniforms on every `updateUniforms()` call (slider drag, parameter change). |

**Built-in uniforms (main renderer, lines 880-898):**
- `u_time` -- `uniform1f` (line 886)
- `u_resolution` -- `uniform2f` (line 889)
- `u_dpr` -- `uniform1f` (line 892)
- `u_ref_size` -- `uniform1f` (line 895)
- `u_viewport` -- `uniform2f` (line 898)

**Upload helper (line 640-648):** Dispatches by array length:
- scalar -- `uniform1f`
- length 2 -- `uniform2f`
- length 3 -- `uniform3f`
- length 4 -- `uniform4f`

**Multi-pass uniform routing (lines 600-624):** In multi-pass mode,
`updateUniforms` iterates each pass stage, calls `useProgram(ps.program)`
on any pass that owns the changed uniform, then uploads via the helper.

---

## 10. Framebuffer Object Management

| | |
|---|---|
| **Description** | Allocate, resize, and destroy FBOs used as intermediate render targets in multi-pass rendering. Each FBO wraps a TEXTURE_2D color attachment. |
| **Call sites** | |
| -- Allocate (main) | `src/webgl/renderer.ts:318-347` |
| -- Resize (main) | `src/webgl/renderer.ts:350-367` |
| -- Destroy (main) | `src/webgl/renderer.ts:369-376` |
| -- Allocate (preview, main FBO) | `src/webgl/preview-renderer.ts:66-77` |
| -- Allocate (preview, ping-pong) | `src/webgl/preview-renderer.ts:333-352` |

### Allocate (main, lines 318-347)

| WebGL calls | |
|---|---|
| Per FBO | `createTexture`, `bindTexture(TEXTURE_2D)`, `texImage2D(TEXTURE_2D, 0, RGBA8, w, h, 0, RGBA, UNSIGNED_BYTE, null)`, `texParameteri` x4 (WRAP_S CLAMP_TO_EDGE, WRAP_T CLAMP_TO_EDGE, MIN_FILTER LINEAR, MAG_FILTER LINEAR), `bindTexture(TEXTURE_2D, null)`, `createFramebuffer`, `bindFramebuffer(FRAMEBUFFER)`, `framebufferTexture2D(FRAMEBUFFER, COLOR_ATTACHMENT0, TEXTURE_2D, tex, 0)`, `bindFramebuffer(FRAMEBUFFER, null)` |

**Frequency:** Once when switching to a multi-pass render plan. Number of
FBOs equals `passCount - 1` (last pass renders to screen).

### Resize (main, lines 350-367)

| WebGL calls | |
|---|---|
| Per FBO | `bindTexture(TEXTURE_2D, fbo.texture)`, `texImage2D(TEXTURE_2D, 0, RGBA8, w, h, ...)`, `bindTexture(TEXTURE_2D, null)` |

**Frequency:** On canvas resize (ResizeObserver). Only reallocates texture
storage; framebuffer binding is unchanged.

### Destroy (main, lines 369-376)

| WebGL calls | |
|---|---|
| Per FBO | `deleteFramebuffer(fbo.framebuffer)`, `deleteTexture(fbo.texture)` |

**Frequency:** When switching away from multi-pass, or on renderer teardown.

### Preview FBOs (preview-renderer.ts:66-77, 333-352)

The preview renderer maintains:
- **1 main FBO** (80x80, allocated at init, line 66-77) -- always present, used for readback.
- **2 ping-pong FBOs** (80x80, allocated lazily on first multi-pass render, lines 333-352) -- each has identical setup to the main renderer FBOs but with `texParameteri` x4 per texture.

---

## 11. Texture Management

| | |
|---|---|
| **Description** | Upload, replace, and delete image textures used by Image/Texture nodes (sampler2D ports). |
| **Call sites** | |
| -- Upload | `src/webgl/renderer.ts:383-408` |
| -- Delete | `src/webgl/renderer.ts:411-418` |

### Upload (lines 383-408)

| WebGL calls | |
|---|---|
| Guard | `isContextLost()` |
| Replace existing | `deleteTexture(existing)` |
| Create | `createTexture` |
| Configure | `bindTexture(TEXTURE_2D, tex)`, `pixelStorei(UNPACK_FLIP_Y_WEBGL, true)`, `texImage2D(TEXTURE_2D, 0, RGBA, RGBA, UNSIGNED_BYTE, image)` (HTMLImageElement overload), `pixelStorei(UNPACK_FLIP_Y_WEBGL, false)`, `texParameteri` x4 (WRAP_S CLAMP_TO_EDGE, WRAP_T CLAMP_TO_EDGE, MIN_FILTER LINEAR, MAG_FILTER LINEAR), `bindTexture(TEXTURE_2D, null)` |

**Frequency:** Once per image load or replacement. Called from `App.tsx`
when image node data changes.

### Delete (lines 411-418)

| WebGL calls | |
|---|---|
| | `isContextLost()` (guard), `deleteTexture(tex)` |

**Frequency:** When an image node is removed or its source changes.

---

## 12. Texture Binding and Sampling

| | |
|---|---|
| **Description** | Bind image textures to texture units and set corresponding sampler uniforms before draw calls. |
| **Call sites** | `src/webgl/renderer.ts:421-436` (single-pass image binding), `src/webgl/renderer.ts:845-856` (multi-pass inter-pass + image binding) |

### Single-pass image binding (lines 421-436)

| WebGL calls | Per texture unit |
|---|---|
| | `activeTexture(TEXTURE0 + unit)`, `bindTexture(TEXTURE_2D, tex)`, `uniform1i(loc, unit)` |

### Multi-pass texture binding (lines 845-856)

| WebGL calls | Per input texture per pass |
|---|---|
| | `activeTexture(TEXTURE0 + unit)`, `bindTexture(TEXTURE_2D, tex)`, `texParameteri(TEXTURE_2D, TEXTURE_WRAP_S, CLAMP_TO_EDGE)`, `texParameteri(TEXTURE_2D, TEXTURE_WRAP_T, CLAMP_TO_EDGE)`, `uniform1i(loc, unit)` |

The multi-pass path redundantly sets `WRAP_S`/`WRAP_T` per bind (lines
847-848) since intermediate FBO textures might have been created with
different parameters in a future scenario.

**Frequency:** Every frame, once per bound texture per pass.

---

## 13. Single-Pass Rendering

| | |
|---|---|
| **Description** | Draw the fullscreen quad with the current program to the default framebuffer (screen). |
| **Call sites** | `src/webgl/renderer.ts:786-800` |
| **WebGL calls** | `viewport(0, 0, w, h)`, `useProgram(this.program)`, (built-in uniform upload -- see section 9), (image texture binding -- see section 12), `bindVertexArray(this.vao)`, `drawArrays(TRIANGLES, 0, 6)`, `bindVertexArray(null)` |
| **Frequency** | 60 fps when animated, once on static redraws. |

This is the hot path for simple graphs. The sequence is:
1. Set viewport to canvas pixel dimensions
2. Activate program
3. Upload built-in uniforms (time, resolution, etc.)
4. Bind any image textures
5. Bind VAO
6. Draw 6 vertices (2 triangles)
7. Unbind VAO

---

## 14. Multi-Pass Rendering

| | |
|---|---|
| **Description** | Render a chain of passes, each with its own program and FBO target. The last pass writes to the screen. Intermediate passes write to FBO textures that subsequent passes sample. |
| **Call sites** | `src/webgl/renderer.ts:802-877` |

### Per-frame call sequence

| Step | Lines | WebGL calls |
|---|---|---|
| Bind VAO (once) | 813 | `bindVertexArray(this.vao)` |
| **Per pass:** | | |
| Bind target FBO | 826 or 832 | `bindFramebuffer(FRAMEBUFFER, null)` (last pass) or `bindFramebuffer(FRAMEBUFFER, fbo.framebuffer)` (intermediate) |
| Set viewport | 827 or 833 | `viewport(0, 0, w, h)` or `viewport(0, 0, fbo.width, fbo.height)` |
| Activate program | 836 | `useProgram(ps.program)` |
| Upload built-ins | (via helper) | `uniform1f`, `uniform2f` (see section 9) |
| Bind input textures | 845-856 | `activeTexture`, `bindTexture`, `texParameteri` x2, `uniform1i` per input |
| Draw | 863 | `drawArrays(TRIANGLES, 0, 6)` |
| Unbind intermediate FBO | 867 | `bindFramebuffer(FRAMEBUFFER, null)` |
| **Cleanup (once):** | | |
| Reset texture state | 874-875 | `activeTexture(TEXTURE0)`, `bindTexture(TEXTURE_2D, null)` |
| Unbind VAO | 876 | `bindVertexArray(null)` |

**Frequency:** 60 fps when animated. Each frame issues N draw calls where N
is the pass count. Typical graphs produce 1-4 passes.

---

## 15. Preview Single-Pass Rendering

| | |
|---|---|
| **Description** | Render a single-pass shader to the preview FBO at 80x80, then read pixels back. |
| **Call sites** | `src/webgl/preview-renderer.ts:91-171` |

### Call sequence

| Step | Lines | WebGL calls |
|---|---|---|
| Cache lookup / compile | 95-113 | (see sections 5-7) `deleteProgram` on eviction |
| Activate program | 116 | `useProgram(program)` |
| Built-in uniforms | 119-135 | `getUniformLocation` x6, `uniform1f` x3, `uniform2f` x3 |
| User uniforms | 138-149 | `getUniformLocation` + `uniform1f`/`2f`/`3f`/`4f` per uniform |
| Render to FBO | 153-156 | `bindFramebuffer(FRAMEBUFFER, this.fbo)`, `viewport(0, 0, 80, 80)`, `bindVertexArray(this.vao)`, `drawArrays(TRIANGLES, 0, 6)` |
| Readback | 157 | `readPixels(0, 0, 80, 80, RGBA, UNSIGNED_BYTE, buf)` |
| Cleanup | 160 | `bindFramebuffer(FRAMEBUFFER, null)` |

**Frequency:** Once per preview request. The scheduler batches and
throttles these to avoid overwhelming the GPU.

Note: The preview renderer calls `getUniformLocation` inline on every
render, unlike the main renderer which pre-caches locations.

---

## 16. Preview Multi-Pass Rendering

| | |
|---|---|
| **Description** | Multi-pass rendering at 80x80 with ping-pong FBOs. Final result is copied to the main FBO for readback. |
| **Call sites** | `src/webgl/preview-renderer.ts:223-328` |

### Call sequence

| Step | Lines | WebGL calls |
|---|---|---|
| Ensure ping-pong FBOs | 235 | (see section 10, allocate on first use) |
| **Per pass:** | | |
| Cache lookup / compile | 245-262 | (see sections 5-7) |
| Bind target FBO | 264-269 | `bindFramebuffer(FRAMEBUFFER, ...)` -- last pass -> main FBO, intermediate -> pingPong[i%2] |
| Set viewport | 271 | `viewport(0, 0, 80, 80)` |
| Activate program | 272 | `useProgram(program)` |
| Built-in uniforms | 275-284 | `getUniformLocation` x6, `uniform1f` x3, `uniform2f` x3 |
| User uniforms | 287-294 | `getUniformLocation` + `uniform1f`/`2f`/`3f`/`4f` |
| Bind input textures | 297-305 | `activeTexture`, `bindTexture`, `getUniformLocation`, `uniform1i` |
| Draw | 308-309 | `bindVertexArray(this.vao)`, `drawArrays(TRIANGLES, 0, 6)` |
| **Cleanup:** | | |
| Reset texture state | 313-314 | `activeTexture(TEXTURE0)`, `bindTexture(TEXTURE_2D, null)` |
| Readback from main FBO | 317-319 | `bindFramebuffer(FRAMEBUFFER, this.fbo)`, `readPixels(...)`, `bindFramebuffer(FRAMEBUFFER, null)` |

**Frequency:** Once per multi-pass preview request. More expensive than
single-pass but still throttled by the scheduler.

---

## 17. GPU Readback

| | |
|---|---|
| **Description** | Read rendered pixels from the FBO into a CPU-side `Uint8Array` for conversion to an `ImageData` / data URL. |
| **Call sites** | `src/webgl/preview-renderer.ts:157` (single-pass), `src/webgl/preview-renderer.ts:317-319` (multi-pass) |
| **WebGL calls** | `readPixels(0, 0, 80, 80, RGBA, UNSIGNED_BYTE, this.readBuf)` |
| **Frequency** | Once per preview render. Always 80x80 x 4 bytes = 25,600 bytes. |

The main renderer never reads pixels back -- it only renders to screen.
Readback is exclusive to the preview pipeline.

---

## 18. Screen Clear

| | |
|---|---|
| **Description** | Clear the screen to black. Used as a fallback when no valid shader is loaded. |
| **Call sites** | `src/webgl/renderer.ts:931-938` |
| **WebGL calls** | `bindFramebuffer(FRAMEBUFFER, null)`, `viewport(0, 0, w, h)`, `clearColor(0, 0, 0, 1)`, `clear(COLOR_BUFFER_BIT)` |
| **Frequency** | Rare. Called on shader compilation failure or before first successful compile. |

---

## 19. Resource Teardown

| | |
|---|---|
| **Description** | Free all GPU resources when the renderer is destroyed (component unmount, page unload). |

### Main renderer (`src/webgl/renderer.ts:940-962`)

| Step | Lines | WebGL calls |
|---|---|---|
| Destroy FBOs | 945 | `deleteFramebuffer`, `deleteTexture` per FBO (via `destroyFBOs`) |
| Delete image textures | 948-950 | `deleteTexture` per image (via `deleteImageTexture`) |
| Delete cached programs | 955 | `deleteProgram` per cache entry |
| Delete current program | 959 | `deleteProgram(this.program)` |
| Delete VAO | 960 | `deleteVertexArray(this.vao)` |
| Delete VBO | 961 | `deleteBuffer(this.buffer)` |

### Preview renderer (`src/webgl/preview-renderer.ts:354-367`)

| Step | Lines | WebGL calls |
|---|---|---|
| Delete cached programs | 356 | `deleteProgram` per cache entry |
| Delete main FBO | 358-359 | `deleteFramebuffer`, `deleteTexture` |
| Delete ping-pong FBOs | 361-364 | `deleteFramebuffer`, `deleteTexture` x2 |
| Delete vertex shader | 366 | `deleteShader(this.vertexShader)` |

**Frequency:** Once, on unmount.

---

## 20. Extensions

| Extension | Call site | Purpose |
|---|---|---|
| `KHR_parallel_shader_compile` | `renderer.ts:187` | Enables `COMPLETION_STATUS_KHR` polling for async shader compilation. When available, `compileProgram` can return before compilation finishes and the render loop polls for readiness. When absent, `compileShader`/`linkProgram` block synchronously. |

No other extensions are used. The codebase targets WebGL2 baseline features only.

---

## 21. Multi-Pass Architecture Deep Dive

### FBO Topology (Main Renderer)

The compiler partitions the node graph into ordered passes when a node
needs to sample another node's output as a texture (e.g., post-process
nodes reading upstream results).

```
Pass 0 (upstream)      Pass 1 (downstream)     Pass N-1 (final)
   |                      |                        |
   v                      v                        v
[FBO 0 texture] -----> [FBO 1 texture] -----> [screen (null FBO)]
```

- FBO count = `passCount - 1` (last pass targets the screen).
- FBOs are allocated at render plan update time (`allocateFBOs`, line 318).
- FBOs are resized on canvas resize (`resizeFBOs`, line 350).
- FBOs are destroyed on plan change or teardown (`destroyFBOs`, line 369).

### Ping-Pong Topology (Preview Renderer)

The preview renderer uses a simpler 2-FBO ping-pong:

```
Pass 0 -> pingPong[0]
Pass 1 -> pingPong[1]  (reads pingPong[0])
Pass 2 -> pingPong[0]  (reads pingPong[1])
  ...
Pass N-1 -> main FBO   (reads pingPong[(N-2)%2])
                        -> readPixels
```

Ping-pong FBOs are allocated lazily on first multi-pass preview
(`ensurePingPongFBOs`, line 333) and persist until destroy.

### Dirty Propagation

Dirty propagation is handled at the scheduler layer
(`src/webgl/preview-scheduler.ts`), not in the WebGL renderers themselves.
The scheduler tracks which nodes have changed and only re-renders affected
preview thumbnails. The renderers are stateless with respect to dirtiness --
they render whatever they are told to render.

---

## 22. State Persistence Analysis

### State that persists across frames (never reset)

| Resource | Renderer | Created | Destroyed |
|---|---|---|---|
| WebGL2 context | Both | Constructor | Never (GC on canvas removal) |
| Fullscreen quad VAO + VBO | Both | `initQuad` / constructor | `destroy` |
| Program cache (LRU) | Both | Lazy per compile | Eviction or `destroy` |
| Uniform location cache | Main only | `buildUniformCache` | Replaced on recompile |
| FBO array (intermediate passes) | Main | `allocateFBOs` | `destroyFBOs` / plan change |
| Main FBO (readback) | Preview | Constructor | `destroy` |
| Ping-pong FBOs | Preview | `ensurePingPongFBOs` (lazy) | `destroy` |
| Image textures | Main | `uploadImageTexture` | `deleteImageTexture` / `destroy` |
| Vertex shader (shared) | Preview | Constructor | `destroy` |
| GPU caps / extension refs | Main | `detectGPUCaps` | Never |

### State reset every frame

| State | Renderer | Details |
|---|---|---|
| Active program (`useProgram`) | Both | Set per pass, not preserved between frames |
| Bound FBO (`bindFramebuffer`) | Both | Set per pass, reset to null after render |
| Active texture unit (`activeTexture`) | Both | Set per texture bind, reset to TEXTURE0 after multi-pass |
| Bound textures (`bindTexture`) | Both | Set per pass input, reset to null after multi-pass |
| Viewport (`viewport`) | Both | Set per pass to match target dimensions |
| Uniform values | Both | Uploaded every frame (built-ins) or on change (user) |
| VAO binding | Both | Bound before draw, unbound after |

### State never explicitly set

| State | Notes |
|---|---|
| Blend mode | Never enabled. All rendering is opaque fullscreen quad. |
| Depth test | Never enabled. 2D only. |
| Stencil | Never used. |
| Scissor | Never used. |
| Face culling | Never enabled (not needed for fullscreen quad). |
| Polygon offset | Never used. |
| `clearColor` | Only set in `clear()` fallback path (line 935). |

---

## 23. Summary Table of Unique WebGL API Calls

Every distinct WebGL2 API method invoked anywhere in the codebase:

| # | WebGL API Call | Category | Files |
|---|---|---|---|
| 1 | `getContext('webgl2')` | Context | renderer.ts, preview-renderer.ts |
| 2 | `isContextLost()` | Context | renderer.ts |
| 3 | `getParameter(pname)` | Query | renderer.ts |
| 4 | `getExtension(name)` | Extension | renderer.ts |
| 5 | `createVertexArray()` | Geometry | renderer.ts, preview-renderer.ts |
| 6 | `bindVertexArray(vao)` | Geometry | renderer.ts, preview-renderer.ts |
| 7 | `deleteVertexArray(vao)` | Geometry | renderer.ts |
| 8 | `createBuffer()` | Geometry | renderer.ts, preview-renderer.ts |
| 9 | `bindBuffer(target, buf)` | Geometry | renderer.ts, preview-renderer.ts |
| 10 | `bufferData(target, data, usage)` | Geometry | renderer.ts, preview-renderer.ts |
| 11 | `deleteBuffer(buf)` | Geometry | renderer.ts |
| 12 | `enableVertexAttribArray(index)` | Geometry | renderer.ts, preview-renderer.ts |
| 13 | `vertexAttribPointer(...)` | Geometry | renderer.ts, preview-renderer.ts |
| 14 | `createShader(type)` | Shader | renderer.ts, preview-renderer.ts |
| 15 | `shaderSource(shader, src)` | Shader | renderer.ts, preview-renderer.ts |
| 16 | `compileShader(shader)` | Shader | renderer.ts, preview-renderer.ts |
| 17 | `getShaderParameter(shader, pname)` | Shader | renderer.ts, preview-renderer.ts |
| 18 | `getShaderInfoLog(shader)` | Shader | renderer.ts, preview-renderer.ts |
| 19 | `deleteShader(shader)` | Shader | renderer.ts, preview-renderer.ts |
| 20 | `createProgram()` | Program | renderer.ts |
| 21 | `attachShader(prog, shader)` | Program | renderer.ts |
| 22 | `bindAttribLocation(prog, idx, name)` | Program | renderer.ts |
| 23 | `linkProgram(prog)` | Program | renderer.ts |
| 24 | `getProgramParameter(prog, pname)` | Program | renderer.ts |
| 25 | `getProgramInfoLog(prog)` | Program | renderer.ts |
| 26 | `deleteProgram(prog)` | Program | renderer.ts, preview-renderer.ts |
| 27 | `useProgram(prog)` | Program | renderer.ts, preview-renderer.ts |
| 28 | `getActiveUniform(prog, idx)` | Uniform | renderer.ts |
| 29 | `getUniformLocation(prog, name)` | Uniform | renderer.ts, preview-renderer.ts |
| 30 | `uniform1f(loc, v)` | Uniform | renderer.ts, preview-renderer.ts |
| 31 | `uniform2f(loc, v0, v1)` | Uniform | renderer.ts, preview-renderer.ts |
| 32 | `uniform3f(loc, v0, v1, v2)` | Uniform | renderer.ts, preview-renderer.ts |
| 33 | `uniform4f(loc, v0, v1, v2, v3)` | Uniform | renderer.ts, preview-renderer.ts |
| 34 | `uniform1i(loc, v)` | Uniform | renderer.ts, preview-renderer.ts |
| 35 | `createTexture()` | Texture | renderer.ts, preview-renderer.ts |
| 36 | `bindTexture(target, tex)` | Texture | renderer.ts, preview-renderer.ts |
| 37 | `deleteTexture(tex)` | Texture | renderer.ts, preview-renderer.ts |
| 38 | `texImage2D(...)` | Texture | renderer.ts, preview-renderer.ts |
| 39 | `texParameteri(target, pname, val)` | Texture | renderer.ts, preview-renderer.ts |
| 40 | `pixelStorei(pname, val)` | Texture | renderer.ts |
| 41 | `activeTexture(unit)` | Texture | renderer.ts, preview-renderer.ts |
| 42 | `createFramebuffer()` | FBO | renderer.ts, preview-renderer.ts |
| 43 | `bindFramebuffer(target, fb)` | FBO | renderer.ts, preview-renderer.ts |
| 44 | `framebufferTexture2D(...)` | FBO | renderer.ts, preview-renderer.ts |
| 45 | `deleteFramebuffer(fb)` | FBO | renderer.ts, preview-renderer.ts |
| 46 | `viewport(x, y, w, h)` | Render | renderer.ts, preview-renderer.ts |
| 47 | `drawArrays(mode, first, count)` | Render | renderer.ts, preview-renderer.ts |
| 48 | `clearColor(r, g, b, a)` | Render | renderer.ts |
| 49 | `clear(mask)` | Render | renderer.ts |
| 50 | `readPixels(...)` | Readback | preview-renderer.ts |

**Total: 50 unique WebGL2 API calls across 2 files.**

No calls to `uniform1iv`, `uniformMatrix*`, `drawElements`,
`bufferSubData`, `copyTexImage2D`, `blitFramebuffer`, `renderbuffer*`,
`transformFeedback*`, `beginQuery`/`endQuery`, or any other advanced
WebGL2 features. The surface area is compact and maps cleanly to a
small renderer abstraction interface.
