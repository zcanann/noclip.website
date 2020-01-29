
import * as F3DEX from '../BanjoKazooie/f3dex';
import * as RDP from '../Common/N64/RDP';

import ArrayBufferSlice from "../ArrayBufferSlice";
import { nArray, assert, assertExists, hexzero } from "../util";
import { ImageFormat } from "../Common/N64/Image";
import { vec4 } from 'gl-matrix';

// Interpreter for N64 F3DEX2 microcode.

export const enum RSP_Geometry {
    G_ZBUFFER = 1 << 0,
    G_SHADE = 1 << 2,
    G_CULL_FRONT = 1 << 9,
    G_CULL_BACK = 1 << 10,
    G_FOG = 1 << 16,
    G_LIGHTING = 1 << 17,
    G_TEXTURE_GEN = 1 << 18,
    G_TEXTURE_GEN_LINEAR = 1 << 19,
    G_SHADING_SMOOTH = 1 << 21,
    G_CLIPPING = 1 << 23,
}

export class RSPState {
    private output = new F3DEX.RSPOutput();

    private stateChanged: boolean = false;
    private vertexCache = nArray(64, () => new F3DEX.StagingVertex());

    private SP_GeometryMode: number = 0;
    private SP_TextureState = new F3DEX.TextureState();
    private primColor = vec4.create();

    private DP_OtherModeL: number = 0;
    private DP_OtherModeH: number = 0;
    private DP_CombineL: number = 0;
    private DP_CombineH: number = 0;
    private DP_TextureImageState = new F3DEX.TextureImageState();
    private DP_TileState = nArray(8, () => new F3DEX.TileState());
    private DP_TMemTracker = new Map<number, number>();

    constructor(public segments: ArrayBufferSlice[], public sharedOutput: F3DEX.RSPSharedOutput, public dataStart: number) {
    }

    public finish(): F3DEX.RSPOutput | null {
        this._flushDrawCall();
        if (this.output.drawCalls.length === 0) {
            console.log("empty", this.sharedOutput)
            return null;
        }

        return this.output;
    }

    private _setGeometryMode(newGeometryMode: number) {
        if (this.SP_GeometryMode === newGeometryMode)
            return;

        this.stateChanged = true;
        this.SP_GeometryMode = newGeometryMode;
    }

    public gSPSetGeometryMode(mask: number): void {
        this._setGeometryMode(this.SP_GeometryMode | mask);
    }

    public gSPClearGeometryMode(mask: number): void {
        this._setGeometryMode(this.SP_GeometryMode & ~mask);
    }

    public gSPTexture(on: boolean, tile: number, level: number, s: number, t: number): void {
        // This is the texture we're using to rasterize triangles going forward.
        this.SP_TextureState.set(on, tile, level, s / 0x10000, t / 0x10000);
        this.stateChanged = true;
    }

    public gSPVertex(dramAddr: number, n: number, v0: number): void {
        const addr = dramAddr - this.dataStart;
        const view = this.segments[0].createDataView(addr);
        for (let i = 0; i < n; i++) {
            this.vertexCache[v0 + i].setFromView(view, i * 0x10);
        }
    }

    private _translateTileTexture(tileIndex: number): number {
        const tile = this.DP_TileState[tileIndex];

        const dramAddr = assertExists(this.DP_TMemTracker.get(tile.tmem));

        let dramPalAddr: number;
        if (tile.fmt === ImageFormat.G_IM_FMT_CI) {
            const textlut = (this.DP_OtherModeH >>> 14) & 0x03;
            // assert(textlut === TextureLUT.G_TT_RGBA16);

            const palTmem = 0x100 + (tile.palette << 4);
            dramPalAddr = assertExists(this.DP_TMemTracker.get(palTmem));
        } else {
            dramPalAddr = 0;
        }

        return this.sharedOutput.textureCache.translateTileTexture(this.segments, dramAddr - this.dataStart, dramPalAddr - this.dataStart, tile);
    }

    private _flushTextures(dc: F3DEX.DrawCall): void {
        // If textures are not on, then we have no textures.
        if (!this.SP_TextureState.on)
            return;

        const lod_en = !!((this.DP_OtherModeH >>> 16) & 0x01);
        if (lod_en) {
            // TODO(jstpierre): Support mip-mapping
            assert(false);
        } else {
            // We're in TILE mode. Now check if we're in two-cycle mode.
            const cycletype = F3DEX.getCycleTypeFromOtherModeH(this.DP_OtherModeH);
            assert(cycletype === F3DEX.OtherModeH_CycleType.G_CYC_1CYCLE || cycletype === F3DEX.OtherModeH_CycleType.G_CYC_2CYCLE);

            dc.textureIndices.push(this._translateTileTexture(this.SP_TextureState.tile));

            if (this.SP_TextureState.level === 0 && RDP.combineParamsUsesT1(dc.DP_Combine)) {
                // In 2CYCLE mode, it uses tile and tile + 1.
                dc.textureIndices.push(this._translateTileTexture(this.SP_TextureState.tile + 1));
            }
        }
    }

    private _flushDrawCall(): void {
        if (this.stateChanged) {
            this.stateChanged = false;

            const dc = this.output.newDrawCall(this.sharedOutput.indices.length);
            dc.SP_GeometryMode = this.SP_GeometryMode;
            dc.SP_TextureState.copy(this.SP_TextureState);
            dc.DP_Combine = RDP.decodeCombineParams(this.DP_CombineH, this.DP_CombineL);
            dc.DP_OtherModeH = this.DP_OtherModeH;
            dc.DP_OtherModeL = this.DP_OtherModeL;
            this._flushTextures(dc);
        }
    }

    public gSPTri(i0: number, i1: number, i2: number): void {
        if (window.debug)
            console.log('EXEC TRI');
        this._flushDrawCall();

        this.sharedOutput.loadVertex(this.vertexCache[i0]);
        this.sharedOutput.loadVertex(this.vertexCache[i1]);
        this.sharedOutput.loadVertex(this.vertexCache[i2]);
        this.sharedOutput.indices.push(
            this.vertexCache[i0].outputIndex,
            this.vertexCache[i1].outputIndex,
            this.vertexCache[i2].outputIndex,
        );
        this.output.currentDrawCall.indexCount += 3;
    }

    public gDPSetTextureImage(fmt: number, siz: number, w: number, addr: number): void {
        this.DP_TextureImageState.set(fmt, siz, w, addr);
    }

    public gDPSetTile(fmt: number, siz: number, line: number, tmem: number, tile: number, palette: number, cmt: number, maskt: number, shiftt: number, cms: number, masks: number, shifts: number): void {
        this.DP_TileState[tile].set(fmt, siz, line, tmem, palette, cmt, maskt, shiftt, cms, masks, shifts);
    }

    public gDPLoadTLUT(tile: number, count: number): void {
        // Track the TMEM destination back to the originating DRAM address.
        const tmemDst = this.DP_TileState[tile].tmem;
        this.DP_TMemTracker.set(tmemDst, this.DP_TextureImageState.addr);
    }

    public gDPLoadBlock(tileIndex: number, uls: number, ult: number, texels: number, dxt: number): void {
        // First, verify that we're loading the whole texture.
        assert(uls === 0 && ult === 0);
        // Verify that we're loading into LOADTILE.
        // assert(tileIndex === 7);

        const tile = this.DP_TileState[tileIndex];

        // Track the TMEM destination back to the originating DRAM address.
        this.DP_TMemTracker.set(tile.tmem, this.DP_TextureImageState.addr);
        this.stateChanged = true;
    }

    public gDPSetTileSize(tile: number, uls: number, ult: number, lrs: number, lrt: number): void {
        this.DP_TileState[tile].setSize(uls, ult, lrs, lrt);
    }

    public gDPSetOtherModeL(sft: number, len: number, w1: number): void {
        const mask = ((1 << len) - 1) << sft;
        const DP_OtherModeL = (this.DP_OtherModeL & ~mask) | (w1 & mask);
        if (DP_OtherModeL !== this.DP_OtherModeL) {
            this.DP_OtherModeL = DP_OtherModeL;
            this.stateChanged = true;
        }
    }

    public gDPSetOtherModeH(sft: number, len: number, w1: number): void {
        const mask = ((1 << len) - 1) << sft;
        const DP_OtherModeH = (this.DP_OtherModeH & ~mask) | (w1 & mask);
        if (DP_OtherModeH !== this.DP_OtherModeH) {
            this.DP_OtherModeH = DP_OtherModeH;
            this.stateChanged = true;
        }
    }

    public gDPSetCombine(w0: number, w1: number): void {
        if (this.DP_CombineH !== w0 || this.DP_CombineL !== w1) {
            this.DP_CombineH = w0;
            this.DP_CombineL = w1;
            this.stateChanged = true;
        }
    }

    public gSPSetPrimColor(r: number, g: number, b: number, a: number) {
        vec4.set(this.primColor, r, g, b, a);
        this.stateChanged = true;
    }
}

const enum F3DEX2_GBI {
    // DMA
    G_VTX               = 0x01,
    G_MODIFYVTX         = 0x02,
    G_CULLDL            = 0x03,
    G_BRANCH_Z          = 0x04,
    G_TRI1              = 0x05,
    G_TRI2              = 0x06,
    G_QUAD              = 0x07,
    G_LINE3D            = 0x08,

    G_TEXTURE           = 0xD7,
    G_POPMTX            = 0xD8,
    G_GEOMETRYMODE      = 0xD9,
    G_MTX               = 0xDA,
    G_DL                = 0xDE,
    G_ENDDL             = 0xDF,

    // RDP
    G_SETCIMG           = 0xFF,
    G_SETZIMG           = 0xFE,
    G_SETTIMG           = 0xFD,
    G_SETCOMBINE        = 0xFC,
    G_SETENVCOLOR       = 0xFB,
    G_SETPRIMCOLOR      = 0xFA,
    G_SETBLENDCOLOR     = 0xF9,
    G_SETFOGCOLOR       = 0xF8,
    G_SETFILLCOLOR      = 0xF7,
    G_FILLRECT          = 0xF6,
    G_SETTILE           = 0xF5,
    G_LOADTILE          = 0xF4,
    G_LOADBLOCK         = 0xF3,
    G_SETTILESIZE       = 0xF2,
    G_LOADTLUT          = 0xF0,
    G_RDPSETOTHERMODE   = 0xEF,
    G_SETPRIMDEPTH      = 0xEE,
    G_SETSCISSOR        = 0xED,
    G_SETCONVERT        = 0xEC,
    G_SETKEYR           = 0xEB,
    G_SETKEYFB          = 0xEA,
    G_RDPFULLSYNC       = 0xE9,
    G_RDPTILESYNC       = 0xE8,
    G_RDPPIPESYNC       = 0xE7,
    G_RDPLOADSYNC       = 0xE6,
    G_TEXRECTFLIP       = 0xE5,
    G_TEXRECT           = 0xE4,
    G_SETOTHERMODE_H    = 0xE3,
    G_SETOTHERMODE_L    = 0xE2,
}


export function runDL_F3DEX2(state: RSPState, addr: number): void {
    const view = state.segments[0].createDataView();
    for (let i = addr - state.dataStart; i < view.byteLength; i += 0x08) {
        const w0 = view.getUint32(i + 0x00);
        const w1 = view.getUint32(i + 0x04);

        const cmd: F3DEX2_GBI = w0 >>> 24;
        // if (window.debug)
        //     console.log(hexzero(i, 8), F3DEX2_GBI[cmd], hexzero(w0, 8), hexzero(w1, 8));

        switch (cmd) {
            case F3DEX2_GBI.G_ENDDL:
                return;

            case F3DEX2_GBI.G_GEOMETRYMODE:
                state.gSPClearGeometryMode(~(w0 & 0x00FFFFFF));
                state.gSPSetGeometryMode(w1);
                break;

            case F3DEX2_GBI.G_SETTIMG: {
                const fmt = (w0 >>> 21) & 0x07;
                const siz = (w0 >>> 19) & 0x03;
                const w = (w0 & 0x0FFF) + 1;
                state.gDPSetTextureImage(fmt, siz, w, w1);
            } break;

            case F3DEX2_GBI.G_SETTILE: {
                const fmt = (w0 >>> 21) & 0x07;
                const siz = (w0 >>> 19) & 0x03;
                const line = (w0 >>> 9) & 0x1FF;
                const tmem = (w0 >>> 0) & 0x1FF;
                const tile = (w1 >>> 24) & 0x07;
                const palette = (w1 >>> 20) & 0x0F;
                const cmt = (w1 >>> 18) & 0x01;
                const maskt = (w1 >>> 14) & 0x0F;
                const shiftt = (w1 >>> 10) & 0x0F;
                const cms = (w1 >>> 8) & 0x01;
                const masks = (w1 >>> 4) & 0x0F;
                const shifts = (w1 >>> 0) & 0x0F;
                state.gDPSetTile(fmt, siz, line, tmem, tile, palette, cmt, maskt, shiftt, cms, masks, shifts);
            } break;

            case F3DEX2_GBI.G_LOADTLUT: {
                const tile = (w1 >>> 24) & 0x07;
                const count = (w1 >>> 14) & 0x3FF;
                state.gDPLoadTLUT(tile, count);
            } break;

            case F3DEX2_GBI.G_LOADBLOCK: {
                const uls = (w0 >>> 12) & 0x0FFF;
                const ult = (w0 >>> 0) & 0x0FFF;
                const tile = (w1 >>> 24) & 0x07;
                const lrs = (w1 >>> 12) & 0x0FFF;
                const dxt = (w1 >>> 0) & 0x0FFF;
                state.gDPLoadBlock(tile, uls, ult, lrs, dxt);
            } break;

            case F3DEX2_GBI.G_VTX: {
                const v0w = (w0 >>> 1) & 0xFF;
                const n = (w0 >>> 12) & 0xFF;
                const v0 = v0w - n;
                state.gSPVertex(w1, n, v0);
            } break;

            case F3DEX2_GBI.G_TRI1: {
                const i0 = ((w0 >>> 16) & 0xFF) / 2;
                const i1 = ((w0 >>> 8) & 0xFF) / 2;
                const i2 = ((w0 >>> 0) & 0xFF) / 2;
                state.gSPTri(i0, i1, i2);
            } break;

            case F3DEX2_GBI.G_TRI2: {
                {
                    const i0 = ((w0 >>> 16) & 0xFF) / 2;
                    const i1 = ((w0 >>> 8) & 0xFF) / 2;
                    const i2 = ((w0 >>> 0) & 0xFF) / 2;
                    state.gSPTri(i0, i1, i2);
                }
                {
                    const i0 = ((w1 >>> 16) & 0xFF) / 2;
                    const i1 = ((w1 >>> 8) & 0xFF) / 2;
                    const i2 = ((w1 >>> 0) & 0xFF) / 2;
                    state.gSPTri(i0, i1, i2);
                }
            } break;

            case F3DEX2_GBI.G_DL: {
                // console.log("skipping DL", hexzero(i + state.dataStart))
                // return;
                const endEarly = (w0 >>> 16) & 0xFF;
                if (endEarly === 1)
                    return;
            } break;

            case F3DEX2_GBI.G_RDPSETOTHERMODE: {
                state.gDPSetOtherModeH(0, 24, w0 & 0x00FFFFFF);
                state.gDPSetOtherModeL(0, 32, w1);
            } break;

            case F3DEX2_GBI.G_SETOTHERMODE_H: {
                const len = ((w0 >>> 0) & 0xFF) + 1;
                const sft = 0x20 - ((w0 >>> 8) & 0xFF) - len;
                state.gDPSetOtherModeH(sft, len, w1);
            } break;

            case F3DEX2_GBI.G_SETOTHERMODE_L: {
                const len = ((w0 >>> 0) & 0xFF) + 1;
                const sft = 0x20 - ((w0 >>> 8) & 0xFF) - len;
                state.gDPSetOtherModeL(sft, len, w1);
            } break;

            case F3DEX2_GBI.G_SETCOMBINE: {
                state.gDPSetCombine(w0 & 0x00FFFFFF, w1);
            } break;

            case F3DEX2_GBI.G_TEXTURE: {
                const level = (w0 >>> 11) & 0x07;
                let tile = (w0 >>> 8) & 0x07;
                const on = !!((w0 >>> 0) & 0x7F);
                const s = (w1 >>> 16) & 0xFFFF;
                const t = (w1 >>> 0) & 0xFFFF;
                state.gSPTexture(on, tile, level, s, t);
            } break;

            case F3DEX2_GBI.G_SETTILESIZE: {
                const uls = (w0 >>> 12) & 0x0FFF;
                const ult = (w0 >>> 0) & 0x0FFF;
                const tile = (w1 >>> 24) & 0x07;
                const lrs = (w1 >>> 12) & 0x0FFF;
                const lrt = (w1 >>> 0) & 0x0FFF;
                state.gDPSetTileSize(tile, uls, ult, lrs, lrt);
            } break;

            case F3DEX2_GBI.G_POPMTX: {
                // state.gSPPopMatrix();
            } break;

            case F3DEX2_GBI.G_SETPRIMCOLOR: {
                const r = (w1 >>> 24) & 0xff;
                const g = (w1 >>> 16) & 0xff;
                const b = (w1 >>> 8) & 0xff;
                const a = (w1 >>> 0) & 0xff;
                state.gSPSetPrimColor(r, g, b, a);
            } break;

            case F3DEX2_GBI.G_SETBLENDCOLOR: {
                const r = (w1 >>> 24) & 0xff;
                const g = (w1 >>> 16) & 0xff;
                const b = (w1 >>> 8) & 0xff;
                const a = (w1 >>> 0) & 0xff;
            } break;

            case F3DEX2_GBI.G_CULLDL:
            case F3DEX2_GBI.G_RDPFULLSYNC:
            case F3DEX2_GBI.G_RDPTILESYNC:
            case F3DEX2_GBI.G_RDPPIPESYNC:
            case F3DEX2_GBI.G_RDPLOADSYNC:
                // Implementation not necessary.
                break;

            default:
                console.error(`Unknown DL opcode: ${cmd.toString(16)} ${hexzero(i, 8)}`);
        }
    }
}