/**
 * WebGPU mipmap generation. WebGPU has no built-in `generateMipmap`, so we blit
 * each level from the one above with a linear-sampled fullscreen triangle (a box
 * downsample). Used for image textures so minification — a 4K image sampled
 * small, or squeezed through pixelate / reeded_glass — stays clean instead of
 * shimmery. rgba8unorm only (every image texture is that format).
 */

/** Full mip chain length for a texture of this size. */
export function mipLevelCount(width: number, height: number): number {
  return 1 + Math.floor(Math.log2(Math.max(1, width, height)))
}

const BLIT_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  return textureSample(src, samp, in.uv);
}
`

// Pipeline + sampler are device-scoped; cache one set per device.
const cache = new WeakMap<GPUDevice, { pipeline: GPURenderPipeline; sampler: GPUSampler }>()

function resources(device: GPUDevice) {
  let c = cache.get(device)
  if (!c) {
    const module = device.createShaderModule({ code: BLIT_WGSL })
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    c = { pipeline, sampler }
    cache.set(device, c)
  }
  return c
}

/**
 * Fill mip levels 1..levels-1 of an rgba8unorm `texture` from level 0 (which
 * must already hold the image). The texture must be created with that
 * `mipLevelCount` and both RENDER_ATTACHMENT + TEXTURE_BINDING usage. Queue-
 * ordered after the level-0 upload, so no explicit sync is needed.
 */
export function generateMipmaps(device: GPUDevice, texture: GPUTexture, levels: number): void {
  if (levels <= 1) return
  const { pipeline, sampler } = resources(device)
  const encoder = device.createCommandEncoder()
  for (let level = 1; level < levels; level++) {
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
        { binding: 1, resource: sampler },
      ],
    })
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(3)
    pass.end()
  }
  device.queue.submit([encoder.finish()])
}
