"use client"

import * as React from "react"
import { useEffect, useRef } from "react"

const MAX_DPR = 2

const MAX_LIGHTS = 8
const MAX_TRAIL = 8

const MAX_SEG = (MAX_LIGHTS + 1) * (MAX_TRAIL + 2)

const SQRT3_2 = 0.8660254037844386

const STEP_RATE = 1.7

const TRAIL_DECAY = 0.62

const HEAD_W = 1.35

const CURSOR_RATE = 3.4
const CURSOR_CHASE = 0.9
const CURSOR_MAX_RATE = 40

const CURSOR_SNAP = 26

const CURSOR_FADE = 0.28

const TURN_W = [0.44, 0.2, 0.06, 0.0, 0.06, 0.2]
const TURN_SUM = TURN_W.reduce((a, b) => a + b, 0)

const VERT_SRC = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`

const FRAG_SRC = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2  uRes;
uniform float uSide;
uniform float uLw;
uniform float uGlow;
uniform vec3  uBg;
uniform vec3  uLine;
uniform vec3  uAccent;
uniform int   uCount;
uniform vec4  uSeg[90];
uniform float uSegW[90];

float toLine(float t) { return abs(fract(t + 0.5) - 0.5); }

void main() {
    vec2 p = gl_FragCoord.xy - uRes * 0.5;

    float h = uSide * 0.8660254;
    float t0 = dot(p, vec2(0.0, 1.0)) / h;
    float t1 = dot(p, vec2(0.8660254, -0.5)) / h;
    float t2 = dot(p, vec2(0.8660254, 0.5)) / h;

    float d = min(min(toLine(t0), toLine(t1)), toLine(t2)) * h;

    float aa = 1.0;
    float groove = 1.0 - smoothstep(uLw, uLw + aa, d);
    float soft = 1.0 - smoothstep(uLw, uLw * 5.0, d);

    vec3 kk = vec3(floor(t0 + 0.5), floor(t1 + 0.5), floor(t2 + 0.5));
    float rnd = fract(sin(dot(kk, vec3(12.9898, 78.233, 37.719))) * 43758.5453);

    vec3 col = uBg * (0.84 + 0.32 * rnd);
    col += vec3(0.022) * soft * (1.0 - groove);
    col = mix(col, uLine, groove);

    float core = 0.0;
    float halo = 0.0;
    float invR2 = 1.0 / max(uGlow * uGlow, 1.0);
    for (int i = 0; i < 90; i++) {
        if (i >= uCount) break;
        vec4 s = uSeg[i];
        vec2 pa = p - s.xy;
        vec2 ba = s.zw - s.xy;
        float bb = dot(ba, ba);
        float tt = bb > 0.0001 ? clamp(dot(pa, ba) / bb, 0.0, 1.0) : 0.0;
        vec2 r = pa - ba * tt;
        float q = dot(r, r) * invR2;
        float w = uSegW[i];

        core += w / (1.0 + q * q * 40.0);
        halo += w / (1.0 + q * 3.0);
    }

    float lit = min(core, 3.0);
    col += uAccent * groove * lit * 2.2;
    col += uAccent * core * 0.10;
    col += uAccent * halo * 0.045;
    col += vec3(1.0) * groove * pow(min(lit, 1.0), 6.0) * 0.6;

    vec2 uv = gl_FragCoord.xy / uRes - 0.5;
    col *= 1.0 - 0.55 * dot(uv, uv);

    gl_FragColor = vec4(col, 1.0);
}
`

function num(v: unknown, fb: number): number {
    return typeof v === "number" && isFinite(v) ? v : fb
}

function parseColor(input: string | undefined, fb: [number, number, number]): [number, number, number] {
    if (!input) return fb
    let str = String(input).trim()
    if (str.slice(0, 4) === "var(") {
        const comma = str.indexOf(",")
        if (comma < 0) return fb
        str = str.slice(comma + 1, str.lastIndexOf(")")).trim()
    }
    if (str.charAt(0) === "#") {
        let hex = str.slice(1)
        if (hex.length === 3 || hex.length === 4) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
        }
        if (hex.length >= 6) {
            const r = parseInt(hex.slice(0, 2), 16)
            const g = parseInt(hex.slice(2, 4), 16)
            const b = parseInt(hex.slice(4, 6), 16)
            if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r / 255, g / 255, b / 255]
        }
        return fb
    }
    const m = str.match(/-?[\d.]+/g)
    if (!m || m.length < 3) return fb
    if (str.slice(0, 3) === "hsl") {
        const hDeg = ((parseFloat(m[0]) % 360) + 360) % 360
        const s = Math.min(100, Math.max(0, parseFloat(m[1]))) / 100
        const l = Math.min(100, Math.max(0, parseFloat(m[2]))) / 100
        const c = (1 - Math.abs(2 * l - 1)) * s
        const x = c * (1 - Math.abs(((hDeg / 60) % 2) - 1))
        const mm = l - c / 2
        const seg = Math.floor(hDeg / 60) % 6
        const t: [number, number, number] =
            seg === 0 ? [c, x, 0] :
            seg === 1 ? [x, c, 0] :
            seg === 2 ? [0, c, x] :
            seg === 3 ? [0, x, c] :
            seg === 4 ? [x, 0, c] : [c, 0, x]
        return [t[0] + mm, t[1] + mm, t[2] + mm]
    }
    return [
        Math.min(255, Math.max(0, parseFloat(m[0]))) / 255,
        Math.min(255, Math.max(0, parseFloat(m[1]))) / 255,
        Math.min(255, Math.max(0, parseFloat(m[2]))) / 255,
    ]
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
    const sh = gl.createShader(type)
    if (!sh) return null
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error("SparkLattice shader:", gl.getShaderInfoLog(sh))
        gl.deleteShader(sh)
        return null
    }
    return sh
}

const DIRS: Array<[number, number]> = [
    [1, 0],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [0, -1],
    [1, -1],
]

type Walker = { i: number; j: number; dir: number; t: number; trail: number[] }

function hexDist(dq: number, dr: number): number {
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2
}

function pickTurn(dir: number): number {
    let r = Math.random() * TURN_SUM
    for (let k = 0; k < 6; k++) {
        r -= TURN_W[k]
        if (r <= 0) return (dir + k) % 6
    }
    return dir
}

interface SparkLatticeProps {
    style?: React.CSSProperties
    background?: string
    lineColor?: string
    accent?: string
    size?: number
    lights?: number
    speed?: number
    trail?: number
    glow?: number
    hover?: number
    width?: number
    height?: number
}

export default function SparkLattice(props: SparkLatticeProps) {
    const {
        style,
        background = "#000000",
        lineColor = "#0F0F0F",
        accent = "#FF2A18",
        size = 132,
        lights = 8,
        speed = 50,
        trail = 2,
        glow = 92,
        hover = 100,
        width,
        height,
    } = props

    const canvasRef = useRef<HTMLCanvasElement>(null)

    const sizeRef = useRef({ w: 0, h: 0 })
    sizeRef.current = { w: num(width, 0), h: num(height, 0) }

    const vRef = useRef({
        bg: [0.114, 0.114, 0.125] as [number, number, number],
        line: [0.039, 0.039, 0.047] as [number, number, number],
        accent: [1, 0.165, 0.094] as [number, number, number],
        size: 96,
        lights: 3,
        speed: 1,
        trail: 6,
        glow: 1,
        hover: 1,
    })
    vRef.current = {
        bg: parseColor(background, [0.114, 0.114, 0.125]),
        line: parseColor(lineColor, [0.039, 0.039, 0.047]),
        accent: parseColor(accent, [1, 0.165, 0.094]),
        size: Math.max(16, num(size, 96)),
        lights: Math.min(MAX_LIGHTS, Math.max(1, Math.round(num(lights, 3)))),
        speed: Math.max(0, num(speed, 50)) / 50,
        trail: Math.min(MAX_TRAIL, Math.max(1, Math.round(num(trail, 6)))),
        glow: Math.max(0.01, num(glow, 100)) / 100,
        hover: Math.max(0, num(hover, 100)) / 100,
    }

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false })
        if (!gl) {
            console.error("SparkLattice: WebGL unavailable")
            return
        }

        const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC)
        const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC)
        if (!vs || !fs) return
        const prog = gl.createProgram()
        if (!prog) return
        gl.attachShader(prog, vs)
        gl.attachShader(prog, fs)
        gl.linkProgram(prog)
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error("SparkLattice link:", gl.getProgramInfoLog(prog))
            return
        }
        gl.useProgram(prog)

        const buf = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, buf)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
        const loc = gl.getAttribLocation(prog, "a_pos")
        gl.enableVertexAttribArray(loc)
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

        const u = {
            res: gl.getUniformLocation(prog, "uRes"),
            side: gl.getUniformLocation(prog, "uSide"),
            lw: gl.getUniformLocation(prog, "uLw"),
            glow: gl.getUniformLocation(prog, "uGlow"),
            bg: gl.getUniformLocation(prog, "uBg"),
            line: gl.getUniformLocation(prog, "uLine"),
            accent: gl.getUniformLocation(prog, "uAccent"),
            count: gl.getUniformLocation(prog, "uCount"),
            seg: gl.getUniformLocation(prog, "uSeg[0]"),
            segW: gl.getUniformLocation(prog, "uSegW[0]"),
        }

        const segData = new Float32Array(MAX_SEG * 4)
        const segW = new Float32Array(MAX_SEG)
        const walkers: Walker[] = []

        let cursor: Walker | null = null
        let presence = 0

        const ptr = { x: 0, y: 0, inside: false }
        const onMove = (e: PointerEvent) => {
            const rect = canvas.getBoundingClientRect()
            if (rect.width <= 0 || rect.height <= 0) return

            const lx = ((e.clientX - rect.left) * canvas.offsetWidth) / rect.width
            const ly = ((e.clientY - rect.top) * canvas.offsetHeight) / rect.height
            ptr.x = lx
            ptr.y = ly
            ptr.inside = lx >= 0 && ly >= 0 && lx <= canvas.offsetWidth && ly <= canvas.offsetHeight
        }
        const onOut = () => {
            ptr.inside = false
        }
        window.addEventListener("pointermove", onMove, { passive: true })
        window.addEventListener("pointerdown", onMove, { passive: true })
        window.addEventListener("pointerleave", onOut)
        window.addEventListener("blur", onOut)

        let raf = 0
        let last = performance.now()

        const render = (now: number) => {
            const dt = Math.min(0.05, (now - last) / 1000)
            last = now
            const v = vRef.current

            const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
            const cw = sizeRef.current.w || canvas.clientWidth || 1200
            const ch = sizeRef.current.h || canvas.clientHeight || 800
            const bw = Math.max(1, Math.round(cw * dpr))
            const bh = Math.max(1, Math.round(ch * dpr))
            if (canvas.width !== bw || canvas.height !== bh) {
                canvas.width = bw
                canvas.height = bh
                gl.viewport(0, 0, bw, bh)
            }

            const side = v.size * dpr
            const halfW = bw * 0.5
            const halfH = bh * 0.5
            const wx = (i: number, j: number) => i * side + j * side * 0.5
            const wy = (i: number, j: number) => j * side * SQRT3_2

            const nearestVertex = (x: number, y: number): [number, number] => {
                const jf = Math.floor(y / (side * SQRT3_2))
                let bi = 0
                let bj = 0
                let bd = Infinity
                for (let dj = 0; dj < 2; dj++) {
                    const j = jf + dj
                    const iff = Math.floor((x - j * side * 0.5) / side)
                    for (let di = 0; di < 2; di++) {
                        const i = iff + di
                        const ex = wx(i, j) - x
                        const ey = wy(i, j) - y
                        const d2 = ex * ex + ey * ey
                        if (d2 < bd) {
                            bd = d2
                            bi = i
                            bj = j
                        }
                    }
                }
                return [bi, bj]
            }

            const aimDir = (i: number, j: number, ti: number, tj: number, fallback: number) => {
                if (i === ti && j === tj) return fallback
                let best = fallback
                let bd = Infinity
                for (let k = 0; k < 6; k++) {
                    const d = hexDist(ti - (i + DIRS[k][0]), tj - (j + DIRS[k][1]))
                    if (d < bd) {
                        bd = d
                        best = k
                    }
                }
                return best
            }

            const spawn = (w: Walker) => {
                const x = (Math.random() * 2 - 1) * halfW * 1.05
                const y = (Math.random() * 2 - 1) * halfH * 1.05
                const j = Math.round(y / (side * SQRT3_2))
                const i = Math.round((x - j * side * 0.5) / side)
                w.i = i
                w.j = j
                w.dir = Math.floor(Math.random() * 6)
                w.t = Math.random()
                w.trail.length = 0
            }

            while (walkers.length < v.lights) {
                const w: Walker = { i: 0, j: 0, dir: 0, t: 0, trail: [] }
                spawn(w)
                walkers.push(w)
            }
            if (walkers.length > v.lights) walkers.length = v.lights

            let n = 0
            const step = dt * STEP_RATE * v.speed
            const margin = side * 2

            const emit = (w: Walker, scale: number) => {
                if (scale <= 0 || n + 2 > MAX_SEG) return
                const cx = wx(w.i, w.j)
                const cy = wy(w.i, w.j)
                const nx = wx(w.i + DIRS[w.dir][0], w.j + DIRS[w.dir][1])
                const ny = wy(w.i + DIRS[w.dir][0], w.j + DIRS[w.dir][1])
                const hx = cx + (nx - cx) * w.t
                const hy = cy + (ny - cy) * w.t

                segData[n * 4] = hx
                segData[n * 4 + 1] = hy
                segData[n * 4 + 2] = hx
                segData[n * 4 + 3] = hy
                segW[n] = HEAD_W * scale
                n++

                segData[n * 4] = cx
                segData[n * 4 + 1] = cy
                segData[n * 4 + 2] = hx
                segData[n * 4 + 3] = hy
                segW[n] = scale
                n++

                const segs = w.trail.length / 2
                let px = cx
                let py = cy
                for (let sg = 0; sg < segs; sg++) {
                    if (n >= MAX_SEG) break
                    const ax = wx(w.trail[sg * 2], w.trail[sg * 2 + 1])
                    const ay = wy(w.trail[sg * 2], w.trail[sg * 2 + 1])
                    let weight = Math.pow(TRAIL_DECAY, sg + 1) * scale
                    if (sg === segs - 1 && segs >= v.trail) weight *= 1 - w.t
                    segData[n * 4] = ax
                    segData[n * 4 + 1] = ay
                    segData[n * 4 + 2] = px
                    segData[n * 4 + 3] = py
                    segW[n] = weight
                    n++
                    px = ax
                    py = ay
                }
            }

            for (let k = 0; k < walkers.length; k++) {
                const w = walkers[k]
                w.t += step
                while (w.t >= 1) {
                    w.t -= 1
                    w.trail.unshift(w.i, w.j)
                    w.i += DIRS[w.dir][0]
                    w.j += DIRS[w.dir][1]
                    w.dir = pickTurn(w.dir)
                }
                if (w.trail.length > v.trail * 2) w.trail.length = v.trail * 2

                if (Math.abs(wx(w.i, w.j)) > halfW + margin || Math.abs(wy(w.i, w.j)) > halfH + margin) {
                    spawn(w)
                    continue
                }
                emit(w, 1)
            }

            if (v.hover > 0) {
                presence = ptr.inside
                    ? Math.min(1, presence + dt / 0.1)
                    : Math.max(0, presence - dt / CURSOR_FADE)

                const px = (ptr.x - cw * 0.5) * dpr

                const py = (ch * 0.5 - ptr.y) * dpr
                const [ti, tj] = nearestVertex(px, py)

                if (!cursor) cursor = { i: ti, j: tj, dir: 0, t: 0, trail: [] }
                const c = cursor

                const gap = hexDist(ti - c.i, tj - c.j)
                if (gap > CURSOR_SNAP || presence === 0) {
                    c.i = ti
                    c.j = tj
                    c.t = 0
                    c.trail.length = 0
                } else {
                    if (c.t === 0) c.dir = aimDir(c.i, c.j, ti, tj, c.dir)
                    const rate = Math.min(CURSOR_MAX_RATE, CURSOR_RATE * (1 + gap * CURSOR_CHASE))
                    c.t += dt * rate
                    while (c.t >= 1) {
                        c.t -= 1
                        c.trail.unshift(c.i, c.j)
                        c.i += DIRS[c.dir][0]
                        c.j += DIRS[c.dir][1]
                        if (c.i === ti && c.j === tj) {
                            c.t = 0
                            break
                        }
                        c.dir = aimDir(c.i, c.j, ti, tj, c.dir)
                    }
                    if (c.trail.length > v.trail * 2) c.trail.length = v.trail * 2
                }
                emit(c, v.hover * presence)
            } else {
                presence = 0
                cursor = null
            }

            gl.uniform2f(u.res, bw, bh)
            gl.uniform1f(u.side, side)
            gl.uniform1f(u.lw, Math.max(0.75, 0.9 * dpr))
            gl.uniform1f(u.glow, Math.max(2, side * 0.9 * v.glow))
            gl.uniform3f(u.bg, v.bg[0], v.bg[1], v.bg[2])
            gl.uniform3f(u.line, v.line[0], v.line[1], v.line[2])
            gl.uniform3f(u.accent, v.accent[0], v.accent[1], v.accent[2])
            gl.uniform1i(u.count, n)
            gl.uniform4fv(u.seg, segData)
            gl.uniform1fv(u.segW, segW)

            gl.drawArrays(gl.TRIANGLES, 0, 3)
            raf = requestAnimationFrame(render)
        }

        raf = requestAnimationFrame(render)

        return () => {
            cancelAnimationFrame(raf)
            window.removeEventListener("pointermove", onMove)
            window.removeEventListener("pointerdown", onMove)
            window.removeEventListener("pointerleave", onOut)
            window.removeEventListener("blur", onOut)
        }
    }, [])

    return (
        <div
            style={{
                position: "relative",
                overflow: "hidden",
                background,
                minWidth: 0,
                minHeight: 0,
                width: typeof width === "number" && width > 0 ? width : "100%",
                height: typeof height === "number" && height > 0 ? height : "100%",
                ...style,
            }}
        >
            <canvas
                ref={canvasRef}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
            />
        </div>
    )
}