// The Floor: a 3D office where every Claude session has a desk. Built with three.js from the FloorModel
// (shared/floor.ts). The layout is rebuilt only when someone moves; every other snapshot updates screens,
// rings and pins in place. Capped at 30 fps and paused while the tab is hidden: it is meant to stay open.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { DESK_COLOR, DESK_WORD, type Desk, type DeskState, type FloorModel } from '../../shared/floor';
import { fmtCache } from '../../shared/types';

/** What the ops wall screens show, beside the desks. */
export interface WallData { owner: string; usage5h: number | null; usageWeek: number | null; envs: { env: string; version: string }[]; feed: string[]; alert: string | null }
export interface FloorEvents { onSelect: (name: string | null) => void; onArea: (lane: string) => void }

// WareTrack-style palette for the room; state colours come from DESK_COLOR.
const WT = { white: '#F7F8FB', blue: '#2D5BE3', blueDk: '#2349C4', blueLt: '#4C7BF0', mist: '#C9D3E6', green: '#47B26B', board: '#D7A86E', wood: '#D9B48A', yellow: '#F5B82E', teal: '#2BB3A3', slate: '#2F3A55' };
const ZONE_TINTS = ['#DCE6FB', '#DFF3E4', '#F3E6D3', '#E3E8F2', '#E6F0FA', '#EEF6E8'];
const ringColor = (st: DeskState) => (st === 'working' ? WT.slate : DESK_COLOR[st]); // white would vanish on the white floor
const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

interface Placed { desk: Desk; group: THREE.Object3D; anchor: THREE.Vector3; ring?: THREE.Mesh; term?: Term; who?: Person; pin?: HTMLElement; act?: string }
interface Person { g: THREE.Group; body: THREE.Group; head: THREE.Mesh; armL?: THREE.Object3D; armR?: THREE.Object3D; legL?: THREE.Object3D; legR?: THREE.Object3D }
interface Term { c: CanvasRenderingContext2D; tex: THREE.CanvasTexture; mat: THREE.MeshBasicMaterial; desk: Desk; frame: number }
interface Label { el: HTMLElement; pos: THREE.Vector3; area?: [number, number, number, number]; onClick?: () => void }

export class FloorScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 2, 340);
  private controls: OrbitControls;
  private composer: EffectComposer | null = null;
  private world = new THREE.Group();
  private placed = new Map<string, Placed>();
  private clickables: THREE.Object3D[] = [];
  private labels: Label[] = [];
  private layoutKey = '';
  private floorW = 0;
  private home = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  private fly: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t0: number; ms: number } | null = null;
  private hovered: string | null = null;
  private selected: string | null = null;
  private lastMove = performance.now();
  private raf = 0;
  private lastFrame = 0;
  private t0 = performance.now();
  private intro = true;
  private zones: { g: THREE.Group; delay: number }[] = [];
  /** People walking from where they were to where they are now (desk to lounge, lounge to the lead office ...). */
  private trips: { who: Person; path: THREE.CurvePath<THREE.Vector3>; t0: number; dur: number; target: Person }[] = [];
  private owner: Person | null = null;
  /** Where the owner can be, and what they do there: they pick one at random every minute or two and walk over. */
  private ownerSpots: { x: number; z: number; y: number; ry: number; act: string; what: string }[] = [];
  private ownerAt = 0;
  private ownerNext = 0;
  private ownerTrip: { path: THREE.CurvePath<THREE.Vector3>; t0: number; dur: number; to: number } | null = null;
  private gamers: Person[] = [];
  private game: { c: CanvasRenderingContext2D; tex: THREE.CanvasTexture } | null = null;
  private wall: { c: CanvasRenderingContext2D; tex: THREE.CanvasTexture; kind: string }[] = [];
  private wallData: WallData = { owner: '', usage5h: null, usageWeek: null, envs: [], feed: [], alert: null };
  private confScreen: { c: CanvasRenderingContext2D; tex: THREE.CanvasTexture } | null = null;
  private model: FloorModel | null = null;
  private hoverEl: HTMLElement;
  private ray = new THREE.Raycaster();
  private ptr = new THREE.Vector2();
  private downAt: [number, number] | null = null;
  private disposed = false;
  private onResize = () => this.resize();
  private onVis = () => { if (!document.hidden && !this.disposed) { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(this.loop); } };

  constructor(private canvas: HTMLCanvasElement, private overlay: HTMLElement, private events: FloorEvents) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    const r = this.renderer;
    // no graphics card (software rendering): skip the expensive extras so the page stays up
    const gl = r.getContext(); const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const soft = /swiftshader|llvmpipe|software|basic render/i.test(String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ''));
    r.setPixelRatio(soft ? 1 : Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = .98; r.outputColorSpace = THREE.SRGBColorSpace;
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), .04).texture;
    (this.scene as any).environmentIntensity = .32;
    this.scene.background = new THREE.Color('#050505');
    this.scene.fog = new THREE.Fog('#050505', 160, 320);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#c7d2e6', .5));
    const sun = new THREE.DirectionalLight('#fff7ec', 2.7);
    sun.position.set(-18, 34, 22); sun.castShadow = true;
    sun.shadow.mapSize.set(soft ? 1024 : 4096, soft ? 1024 : 4096); sun.shadow.bias = -.0006; sun.shadow.normalBias = .06;
    Object.assign(sun.shadow.camera, { left: -48, right: 48, top: 30, bottom: -30 });
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight('#9aa0aa', .35); fill.position.set(24, 12, -18); this.scene.add(fill);
    // a flat wireframe grid all around the floor: clear square cells, not shaded, faded only far away by the fog
    const grid = new THREE.GridHelper(420, 140, '#3A414F', '#3A414F'); grid.position.y = -1.02;
    for (const m of [grid.material].flat() as THREE.LineBasicMaterial[]) { m.transparent = true; m.opacity = .55; m.fog = true; m.toneMapped = false; }
    this.scene.add(grid);
    this.scene.add(this.world);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: .07, minDistance: 14, maxDistance: 130, maxPolarAngle: Math.PI * .44, minPolarAngle: Math.PI * .12, screenSpacePanning: false });
    if (!soft) try {
      const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { samples: 4, type: THREE.HalfFloatType });
      this.composer = new EffectComposer(r, rt);
      this.composer.setPixelRatio(r.getPixelRatio());
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      const ao = new GTAOPass(this.scene, this.camera, innerWidth, innerHeight);
      ao.updateGtaoMaterial({ radius: .5, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: 24 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
      ao.blendIntensity = .6;
      this.composer.addPass(ao);
      this.composer.addPass(new OutputPass());
    } catch { this.composer = null; } // plain rendering on GPUs without it
    this.hoverEl = document.createElement('div'); this.hoverEl.className = 'fl-hover'; overlay.appendChild(this.hoverEl);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVis);
    this.resize();
    this.raf = requestAnimationFrame(this.loop);
  }

  // ---------- public ----------
  setModel(m: FloorModel, wall: WallData) {
    this.model = m; this.wallData = wall;
    if (m.layoutKey !== this.layoutKey) { this.layoutKey = m.layoutKey; this.build(m); }
    else for (const d of m.all) { const p = this.placed.get(d.name); if (p) this.refresh(p, d); }
    this.drawConf(); this.wall.forEach((w) => this.drawWall(w, (performance.now() - this.t0) / 1000));
  }
  select(name: string | null) {
    this.selected = name;
    if (!name) { this.flyTo(this.home.pos, this.home.target); return; }
    const p = this.placed.get(name); if (!p) return;
    const at = p.group.localToWorld(p.anchor.clone()); at.y = 0;
    const off = this.camera.position.clone().sub(this.controls.target).normalize().multiplyScalar(19); off.y = Math.max(off.y, 11);
    this.flyTo(at.clone().add(off), at);
  }
  zoom(f: number) { const d = this.camera.position.clone().sub(this.controls.target).multiplyScalar(f); this.flyTo(this.controls.target.clone().add(d), this.controls.target.clone(), 500); }
  turn(a: number) { const d = this.camera.position.clone().sub(this.controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), a); this.flyTo(this.controls.target.clone().add(d), this.controls.target.clone(), 700); }
  goHome() { this.selected = null; this.flyTo(this.home.pos, this.home.target); }
  dispose() {
    this.disposed = true; cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.onResize); document.removeEventListener('visibilitychange', this.onVis);
    this.canvas.removeEventListener('pointermove', this.onMove); this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointerup', this.onUp); this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.clearWorld(); this.controls.dispose(); this.composer?.dispose(); this.renderer.dispose();
    this.overlay.innerHTML = '';
  }

  // ---------- building blocks ----------
  private M = (c: string, o: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: .62, metalness: .04, ...o });
  private box = (w: number, h: number, d: number, r = .04) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2));
  private add(parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, o: { cast?: boolean; recv?: boolean } = {}) {
    const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); mesh.castShadow = o.cast ?? true; mesh.receiveShadow = o.recv ?? true; parent.add(mesh); return mesh;
  }
  private pick = 0;
  private mats() {
    const M = this.M;
    return {
      slab: M('#D6DDE8', { roughness: .95 }), wall: M(WT.white, { roughness: .9 }), deskTop: M(WT.wood, { roughness: .55 }), met: M(WT.slate, { metalness: .55, roughness: .35 }),
      case: M(WT.white, { roughness: .35 }), bezel: M('#121318', { roughness: .25 }), off: new THREE.MeshStandardMaterial({ color: '#15171C', roughness: .15, metalness: .4 }),
      mesh: M('#2B3142', { roughness: .9 }), frame: M(WT.mist, { metalness: .4, roughness: .35 }), plant: M(WT.green, { roughness: 1 }), pot: M(WT.white), tv: M('#16161A', { roughness: .3 }),
      glass: new THREE.MeshStandardMaterial({ color: '#9FC3F5', transparent: true, opacity: .22, roughness: .05, metalness: .1, depthWrite: false }),
      chairs: [WT.blue, WT.yellow, WT.white, WT.blueLt, WT.green].map((c) => M(c)), shirts: [WT.blue, WT.blueLt, WT.yellow, WT.green, WT.white, WT.teal, WT.blueDk].map((c) => M(c, { roughness: .7 })),
      skins: ['#E5BF9A', '#C68E64', '#F1D3B5', '#8D5B3E', '#D9A77F'].map((c) => M(c, { roughness: .6 })), hair: ['#2B2118', '#5A3A22', '#141414', '#A8743F', '#3B3B44'].map((c) => M(c, { roughness: .9 })),
      pants: ['#2F3A55', '#3B4A6B', '#26324A', '#44506E'].map((c) => M(c, { roughness: .85 })), shoe: M('#F4F4F5', { roughness: .6 }), decor: [WT.yellow, WT.blue, WT.white, WT.green].map((c) => M(c)),
    };
  }
  private mt!: ReturnType<FloorScene['mats']>;

  private person(parent: THREE.Object3D, x: number, z: number, ry: number, seated = true): Person {
    const { add, box } = this, mt = this.mt, k = this.pick++;
    const tone = mt.shirts[k % mt.shirts.length], skin = mt.skins[k % mt.skins.length], hair = mt.hair[k % mt.hair.length], pants = mt.pants[k % mt.pants.length];
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; parent.add(g);
    const body = new THREE.Group(); g.add(body);
    const hipY = seated ? .6 : .92;
    const torso = add.call(this, body, new THREE.CapsuleGeometry(.19, .3, 6, 16), tone, 0, hipY + .36, seated ? -.04 : 0); torso.scale.set(1.08, 1, .78);
    add.call(this, body, new THREE.CylinderGeometry(.06, .07, .1, 12), skin, 0, hipY + .7, seated ? -.03 : 0);
    const head = add.call(this, body, new THREE.SphereGeometry(.16, 24, 18), skin, 0, hipY + .88, seated ? -.02 : 0);
    const cap = add.call(this, head, new THREE.SphereGeometry(.168, 24, 14, 0, Math.PI * 2, 0, Math.PI * .55), hair, 0, .02, -.015); cap.rotation.x = -.25;
    const limb = (pg: THREE.Object3D, px: number, py: number, pz: number, len: number, r: number, m: THREE.Material) => { const pv = new THREE.Group(); pv.position.set(px, py, pz); pg.add(pv); add.call(this, pv, new THREE.CapsuleGeometry(r, len, 4, 10), m, 0, -len / 2 - r * .5, 0); return pv; };
    const p: Person = { g, body, head };
    if (seated) {
      for (const sx of [-.1, .1]) {
        const th = add.call(this, g, new THREE.CapsuleGeometry(.085, .32, 4, 10), pants, sx, hipY, .17); th.rotation.x = Math.PI / 2;
        add.call(this, g, new THREE.CapsuleGeometry(.075, .34, 4, 10), pants, sx, hipY - .27, .36);
        add.call(this, g, box(.11, .07, .22, .03), mt.shoe, sx, .04, .42);
      }
      const arms: THREE.Object3D[] = [];
      for (const sx of [-.25, .25]) { const up = limb(body, sx, hipY + .58, -.03, .22, .06, tone); up.rotation.x = -.55; const fore = limb(up, 0, -.3, 0, .24, .055, skin); fore.rotation.x = -1.0; arms.push(fore); }
      p.armL = arms[0]; p.armR = arms[1];
    } else {
      p.legL = limb(g, -.1, hipY, 0, .62, .085, pants); p.legR = limb(g, .1, hipY, 0, .62, .085, pants);
      add.call(this, p.legL, box(.11, .07, .22, .03), mt.shoe, 0, -.86, .05); add.call(this, p.legR, box(.11, .07, .22, .03), mt.shoe, 0, -.86, .05);
      p.armL = limb(body, -.25, hipY + .58, 0, .5, .06, tone); p.armR = limb(body, .25, hipY + .58, 0, .5, .06, tone);
    }
    return p;
  }
  private chair(parent: THREE.Object3D, x: number, z: number, ry: number) {
    const { box } = this, mt = this.mt, add = this.add.bind(this);
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; parent.add(g);
    const c = mt.chairs[this.pick++ % mt.chairs.length];
    for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; const leg = add(g, box(.04, .03, .3, .01), mt.met, Math.sin(a) * .15, .07, Math.cos(a) * .15); leg.rotation.y = a; add(g, new THREE.SphereGeometry(.035, 10, 8), mt.bezel, Math.sin(a) * .3, .035, Math.cos(a) * .3, { cast: false }); }
    add(g, new THREE.CylinderGeometry(.03, .04, .38, 12), mt.met, 0, .28, 0);
    add(g, box(.56, .09, .52, .04), c, 0, .5, 0);
    const back = add(g, box(.5, .56, .05, .04), mt.mesh, 0, .9, .27); back.rotation.x = -.12;
    add(g, box(.52, .06, .06, .02), c, 0, 1.18, .3);
    for (const sx of [-.31, .31]) { add(g, box(.04, .2, .04, .01), mt.met, sx, .62, .04); add(g, box(.07, .03, .26, .01), mt.bezel, sx, .73, .02); }
  }
  private monitor(g: THREE.Object3D, screen: THREE.Material | null, w = .9, h = .52, x = 0, ry = 0) {
    const { box } = this, mt = this.mt, add = this.add.bind(this);
    const m = new THREE.Group(); m.position.set(x, 0, 0); m.rotation.y = ry; g.add(m);
    add(m, box(w, h, .035, .02), mt.case, 0, 1.32, -.31);
    add(m, box(w - .01, h - .01, .012, .006), mt.bezel, 0, 1.32, -.29, { cast: false });
    add(m, new THREE.PlaneGeometry(w - .045, h - .045), screen ?? mt.off, 0, 1.32, -.283, { cast: false });
    add(m, box(.06, .32, .04, .015), mt.case, 0, 1.0, -.34); add(m, box(.28, .016, .2, .008), mt.case, 0, .81, -.31);
  }
  private deskBody(g: THREE.Object3D, w: number, d: number, seed: number) {
    const { box } = this, mt = this.mt, add = this.add.bind(this);
    add(g, box(w, .045, d, .015), mt.deskTop, 0, .775, 0);
    add(g, box(w + .01, .02, d + .01, .008), mt.case, 0, .745, 0, { cast: false });
    for (const sx of [-w / 2 + .14, w / 2 - .14]) { add(g, box(.05, .7, .05, .01), mt.met, sx, .38, 0); add(g, box(.06, .035, d - .12, .01), mt.met, sx, .02, 0); add(g, box(.05, .035, d - .16, .01), mt.met, sx, .72, 0); }
    add(g, box(w - .5, .05, .14, .01), mt.met, 0, .64, -d / 2 + .12, { cast: false });
    add(g, box(.44, .018, .14, .006), mt.case, 0, .805, .1);
    const mouse = add(g, new THREE.SphereGeometry(.035, 12, 8), mt.case, .33, .81, .12); mouse.scale.set(1, .5, 1.5);
    if (seed % 3 === 0) add(g, new THREE.CylinderGeometry(.045, .04, .1, 16), mt.decor[seed % 4], .62, .85, -.12);
    if (seed % 3 === 1) add(g, box(.21, .015, .29, .005), mt.decor[(seed + 1) % 4], -.6, .805, .02);
    if (seed % 3 === 2) { add(g, new THREE.CylinderGeometry(.06, .05, .1, 12), mt.case, -.68, .85, -.26); add(g, new THREE.SphereGeometry(.09, 12, 10), mt.plant, -.68, .95, -.26); }
  }
  private plant(parent: THREE.Object3D, x: number, z: number, s = 1) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.scale.setScalar(s); parent.add(g);
    this.add(g, new THREE.CylinderGeometry(.28, .22, .5, 16), this.mt.pot, 0, .25, 0);
    for (let i = 0; i < 5; i++) { const l = this.add(g, new THREE.SphereGeometry(.32, 12, 10), this.mt.plant, Math.cos(i * 1.3) * .18, .75 + i * .12, Math.sin(i * 1.3) * .18); l.scale.set(1, 1.3, 1); }
  }
  private glassRoom(parent: THREE.Object3D, x: number, z: number, w: number, d: number, h = 2.6) {
    const g = new THREE.Group(); g.position.set(x, 0, z); parent.add(g);
    const panes: [number, number, number, number][] = [[0, -d / 2, w, .06], [-w / 2, 0, .06, d], [w / 2, 0, .06, d], [-w / 4 - .7, d / 2, w / 2 - 1.4, .06], [w / 4 + .7, d / 2, w / 2 - 1.4, .06]];
    for (const [px, pz, pw, pd] of panes) {
      const m = this.add(g, new THREE.BoxGeometry(pw, h, pd), this.mt.glass, px, h / 2, pz, { cast: false, recv: false }); m.renderOrder = 2;
      this.add(g, this.box(pw + (pw > pd ? 0 : .1), .08, pd + (pd > pw ? 0 : .1), .02), this.mt.frame, px, h + .02, pz, { cast: false, recv: false });
    }
    this.add(g, this.box(w, .04, d, .02), this.M('#E3E8F2', { roughness: 1 }), 0, .09, 0, { cast: false });
    return g;
  }
  private ring(parent: THREE.Object3D, st: DeskState, x: number, z: number, r = .62) {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(ringColor(st)), transparent: true, opacity: st === 'idle' ? .3 : .55, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const ring = this.add(parent, new THREE.RingGeometry(r, r + .12, 48), m, x, .135, z, { cast: false, recv: false }); ring.rotation.x = -Math.PI / 2; ring.renderOrder = 3;
    return ring;
  }
  private hitBox(parent: THREE.Object3D, name: string, x: number, y: number, z: number, w: number, h: number, d: number) {
    const hit = this.add(parent, new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ visible: false }), x, y, z, { cast: false, recv: false });
    hit.userData.session = name; this.clickables.push(hit);
  }
  /** Every visible part of a person (and of their desk) also answers hover and click, not only the invisible box. */
  private hoverable(obj: THREE.Object3D, name: string) {
    obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.userData.session = name; this.clickables.push(o); } });
  }
  /** An area's label: hidden until the pointer is over the area (x0, z0, x1, z1 on the floor); clicking the area runs onClick. */
  private label(text: string, sub: string, pos: THREE.Vector3, onClick?: () => void, area?: [number, number, number, number]) {
    const el = document.createElement('div'); el.className = 'fl-tag'; el.innerHTML = `<b>${esc(text)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}`;
    el.style.opacity = '0';
    this.overlay.appendChild(el); this.labels.push({ el, pos, area, onClick });
  }
  private hoveredArea: Label | null = null;
  private floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // ---------- terminals ----------
  private makeTerm(d: Desk): Term {
    const cv = document.createElement('canvas'); cv.width = 384; cv.height = 224;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const t: Term = { c: cv.getContext('2d')!, tex, mat: new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), desk: d, frame: -1 };
    this.drawTerm(t, 0); return t;
  }
  private drawTerm(T: Term, time: number) {
    const { c } = T, d = T.desk, W = 384, H = 224, st = d.state;
    const edge = st === 'working' ? '#D4D4D8' : DESK_COLOR[st];
    c.fillStyle = '#0B0B0D'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#17171B'; c.fillRect(0, 0, W, 26);
    ['#FF5F57', '#FEBC2E', '#28C840'].forEach((col, i) => { c.fillStyle = col; c.beginPath(); c.arc(14 + i * 14, 13, 4, 0, Math.PI * 2); c.fill(); });
    c.fillStyle = 'rgba(255,255,255,.6)'; c.font = '500 13px "Geist Mono", monospace'; c.fillText(d.name.slice(0, 30), 62, 17);
    c.font = '14px "Geist Mono", monospace';
    const lines = d.lines.length ? d.lines : [st === 'idle' ? '' : '…'];
    const shown = st === 'needs' ? lines.slice(-3) : lines.slice(-8);
    shown.forEach((l, i) => {
      c.fillStyle = l.startsWith('⏺') ? '#F4F4F5' : l.startsWith('>') ? '#9FC3F5' : /error|fail/i.test(l) ? '#F5A524' : 'rgba(255,255,255,.55)';
      c.fillText(l.slice(0, 40), 14, 48 + i * 19);
    });
    if (st === 'needs') {
      const y = 48 + 3 * 19 - 6, on = Math.sin(time * 4) > -.2;
      c.strokeStyle = on ? '#FF5A4F' : 'rgba(255,90,79,.45)'; c.lineWidth = 2; c.strokeRect(12, y, W - 24, 86);
      c.fillStyle = '#FF5A4F'; c.fillText('Waiting for your permission', 24, y + 24);
      c.fillStyle = '#F4F4F5'; c.fillText('❯ 1. Yes', 24, y + 48); c.fillStyle = 'rgba(255,255,255,.5)'; c.fillText('  2. No', 24, y + 70);
    }
    const py = H - 14;
    c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(0, py - 18, W, 1);
    c.fillStyle = 'rgba(255,255,255,.4)'; c.fillText(st === 'working' ? '· esc to interrupt' : '>', 14, py);
    if (st !== 'idle' || Math.floor(time * 2) % 2 === 0) { c.fillStyle = edge; c.fillRect(st === 'working' ? W - 26 : 30, py - 13, 9, 16); }
    c.strokeStyle = edge; c.lineWidth = st === 'working' ? 3 : 5; c.globalAlpha = st === 'idle' ? .5 : 1; c.strokeRect(1.5, 1.5, W - 3, H - 3); c.globalAlpha = 1;
    T.tex.needsUpdate = true;
  }

  // ---------- one desk, with its session ----------
  private desk(parent: THREE.Object3D, d: Desk | null, x: number, z: number, ry: number, seed: number, exec = false) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; parent.add(g);
    const w = exec ? 2.6 : 1.8, dd = exec ? 1.2 : .95;
    this.deskBody(g, w, dd, seed);
    if (!d) { this.monitor(g, null); this.chair(g, 0, .55, 0); return; }
    const term = this.makeTerm(d);
    this.monitor(g, term.mat, exec ? 1.15 : .9);
    if (exec) this.monitor(g, term.mat, .7, .42, -1.0, .45);
    this.chair(g, 0, .82, 0);
    const ring = this.ring(g, d.state, 0, .7);
    const who = d.state === 'idle' ? undefined : this.person(g, 0, .86, Math.PI, true);
    this.hitBox(g, d.name, 0, 1.1, .4, w + .4, 2.2, 2.4);
    this.placed.set(d.name, { desk: d, group: g, anchor: new THREE.Vector3(0, 2.5, .3), ring, term, who });
    this.hoverable(g, d.name);
  }
  private refresh(p: Placed, d: Desk) {
    const changed = p.desk.state !== d.state;
    p.desk = d;
    if (p.term) { p.term.desk = d; this.drawTerm(p.term, (performance.now() - this.t0) / 1000); }
    if (changed && p.ring) { (p.ring.material as THREE.MeshBasicMaterial).color.set(ringColor(d.state)); }
    this.syncPin(p);
  }
  private syncPin(p: Placed) {
    const want = p.desk.state === 'needs' || p.desk.state === 'stuck';
    if (want && !p.pin) {
      const el = document.createElement('div'); el.className = 'fl-pin';
      el.innerHTML = `<svg viewBox="0 0 22 30" width="22" height="30" aria-hidden="true"><path d="M11 29C11 29 2 17 2 11a9 9 0 0 1 18 0c0 6-9 18-9 18z" fill="${DESK_COLOR[p.desk.state]}"/><circle cx="11" cy="11" r="3.6" fill="#050505"/></svg>`;
      this.overlay.appendChild(el); p.pin = el;
    } else if (p.pin && !want) { p.pin.remove(); p.pin = undefined; }
    else if (p.pin) (p.pin.querySelector('path') as SVGPathElement).setAttribute('fill', DESK_COLOR[p.desk.state]);
  }

  // ---------- the whole floor ----------
  private clearWorld() {
    this.world.traverse((o: any) => { o.geometry?.dispose?.(); const m = o.material; (Array.isArray(m) ? m : m ? [m] : []).forEach((x: any) => { x.map?.dispose?.(); x.dispose?.(); }); });
    this.world.clear(); this.placed.clear(); this.clickables = []; this.zones = []; this.gamers = []; this.wall = [];
    for (const l of this.labels) l.el.remove(); this.labels = [];
    this.overlay.querySelectorAll('.fl-pin').forEach((e) => e.remove());
    this.trips = []; this.owner = null; this.ownerSpots = []; this.ownerTrip = null;
  }
  private zone(delay: number) { const g = new THREE.Group(); this.world.add(g); this.zones.push({ g, delay }); return g; }

  private build(m: FloorModel) {
    const was = new Map<string, THREE.Vector3>();
    for (const [name, p] of this.placed) if (p.who) was.set(name, p.who.g.getWorldPosition(new THREE.Vector3()));
    this.clearWorld(); this.pick = 0; this.mt = this.mats();
    const { add, box } = this, mt = this.mt;
    const A = add.bind(this);
    // floor size follows the number of team pods: two rows, one column per two pods
    const cols = Math.max(1, Math.ceil(m.pods.length / 2));
    const workW = Math.max(14, cols * 11), W = workW + 2 + 7 + 13, D = 32;
    const x0 = -W / 2, xRooms = W / 2 - 6.5;
    const gameX = x0 + 1.5 + workW + 3.5; // the games strip runs down the middle of the floor
    this.floorW = W;
    const base = this.zone(0);
    A(base, box(W + 4, 1, D + 4, .3), mt.slab, 0, -.5, 0, { cast: false });
    const cv = document.createElement('canvas'); cv.width = cv.height = 1024; const fc = cv.getContext('2d')!;
    fc.fillStyle = '#EEF1F6'; fc.fillRect(0, 0, 1024, 1024); fc.strokeStyle = 'rgba(47,58,85,.10)'; fc.lineWidth = 2;
    for (let i = 0; i <= 1024; i += 256) { fc.beginPath(); fc.moveTo(i, 0); fc.lineTo(i, 1024); fc.stroke(); fc.beginPath(); fc.moveTo(0, i); fc.lineTo(1024, i); fc.stroke(); }
    const ft = new THREE.CanvasTexture(cv); ft.colorSpace = THREE.SRGBColorSpace; ft.wrapS = ft.wrapT = THREE.RepeatWrapping; ft.repeat.set(W / 8, D / 8); ft.anisotropy = 8;
    A(base, new THREE.BoxGeometry(W, .06, D), new THREE.MeshStandardMaterial({ map: ft, roughness: .85 }), 0, .03, 0, { cast: false });
    // low walls with windows above; a gap in the front wall for the entrance
    const entX = x0 + 1.5 + workW + 3.5; // the entrance is at the front of the games strip
    const walls: [number, number, number, number][] = [[0, -D / 2, W, .3], [-W / 2, 0, .3, D], [W / 2, 0, .3, D], [(x0 + entX - 1.6) / 2, D / 2, entX - 1.6 - x0, .3], [(entX + 1.6 + W / 2) / 2, D / 2, W / 2 - entX - 1.6, .3]];
    for (const [x, z, w, d] of walls) {
      A(base, box(w, 1.6, d), mt.wall, x, .8, z, { cast: false });
      const alongX = w > d, len = alongX ? w : d;
      for (let k = -len / 2; k <= len / 2 + .01; k += 2.9) A(base, box(.12, 1.3, .12, .02), mt.frame, alongX ? x + k : x, 2.3, alongX ? z : z + k, { cast: false, recv: false });
      const pane = A(base, new THREE.BoxGeometry(alongX ? len : .04, 1.3, alongX ? .04 : len), mt.glass, x, 2.31, z, { cast: false, recv: false }); pane.renderOrder = 2;
      A(base, box(alongX ? len : .14, .08, alongX ? .14 : len, .02), mt.frame, x, 3.0, z, { cast: false, recv: false });
    }

    // back strip: ops wall (left) and the coffee bar (middle)
    const ops = this.zone(150);
    const kinds = [['release', 'alert', 'usage'], ['feed', 'sessions', 'cache']];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      const wx = x0 + 3.4 + i * 1.6, wy = 2.3 - j * 1;
      A(ops, box(1.5, .9, .06, .02), mt.tv, wx, wy, -D / 2 + .4);
      const scv = document.createElement('canvas'); scv.width = 320; scv.height = 180;
      const tex = new THREE.CanvasTexture(scv); tex.colorSpace = THREE.SRGBColorSpace;
      A(ops, new THREE.PlaneGeometry(1.42, .8), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), wx, wy, -D / 2 + .45, { cast: false });
      this.wall.push({ c: scv.getContext('2d')!, tex, kind: kinds[j][i] });
    }
    this.desk(ops, m.ops, x0 + 5, -D / 2 + 3.2, Math.PI, 0);
    this.label('Ops wall', m.ops ? m.ops.name : 'monitors and releases', new THREE.Vector3(x0 + 5, 3.6, -D / 2 + .6), m.ops ? () => this.events.onSelect(m.ops!.name) : undefined, [x0, -D / 2, x0 + 9, -D / 2 + 4.6]);
    const cx = x0 + 2 + workW - 3.8;
    A(ops, box(5.6, .95, .8, .05), mt.case, cx, .48, -D / 2 + 1.1); A(ops, box(5.7, .06, .9, .02), mt.deskTop, cx, .98, -D / 2 + 1.1);
    A(ops, box(.55, .55, .45, .05), mt.met, cx - 2, 1.28, -D / 2 + 1); A(ops, box(.9, 2, .7, .06), this.M('#E9EDF3'), cx + 2.4, 1, -D / 2 + .9);
    [WT.yellow, WT.blue, WT.green].forEach((c, i) => { A(ops, new THREE.CylinderGeometry(.22, .22, .08, 20), this.M(c), cx - 1.6 + i * 1.3, .78, -D / 2 + 2.2); A(ops, new THREE.CylinderGeometry(.04, .04, .74, 8), mt.met, cx - 1.6 + i * 1.3, .38, -D / 2 + 2.2); });
    this.label('Coffee bar', '', new THREE.Vector3(cx, 2.4, -D / 2 + 1), undefined, [cx - 3.2, -D / 2, cx + 3.2, -D / 2 + 3]);

    // team pods: two rows, a column per two pods, walkways between
    const work = this.zone(300);
    const rowsZ = [-5.2, 4.8];
    let seed = 0;
    // an odd number of areas leaves a slot in the grid: it becomes free desks, not bare floor
    const pods = m.pods.length % 2 ? [...m.pods, { lane: '', label: 'Free desks', desks: [] as Desk[] }] : m.pods;
    pods.forEach((pod, i) => {
      const px = x0 + 1.5 + 5.5 + Math.floor(i / 2) * 11, pz = rowsZ[i % 2];
      A(work, box(10.4, .04, 7.6, .02), this.M(ZONE_TINTS[i % ZONE_TINTS.length], { roughness: 1 }), px, .09, pz, { cast: false });
      const seats: [number, number, number][] = [[-2.6, -1.6, 0], [0, -1.6, 0], [2.6, -1.6, 0], [-2.6, 1.9, Math.PI], [0, 1.9, Math.PI], [2.6, 1.9, Math.PI]];
      // an idle session's desk stays, empty: the person is in the lounge
      seats.forEach(([sx, sz, ry], k) => { const d = pod.desks[k]; this.desk(work, d && d.state !== 'idle' ? d : null, px + sx, pz + sz, ry, seed++); });
      const part = (x: number, z: number, w: number, ry = 0) => { const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; work.add(g); A(g, box(w, 1.22, .07, .035), mt.frame, 0, .63, 0, { cast: false }); A(g, box(w - .07, 1.14, .08, .03), this.M(WT.blue, { roughness: 1 }), 0, .63, 0); };
      part(px, pz + .15, 8.2); [-1.3, 1.3].forEach((dx) => { part(px + dx, pz - 1.6, 1, Math.PI / 2); part(px + dx, pz + 1.9, 1, Math.PI / 2); });
      // a whiteboard and a cabinet per pod
      const wb = new THREE.Group(); wb.position.set(px - 4.6, 0, pz - 3.3); wb.rotation.y = .4; work.add(wb);
      A(wb, box(2.2, 1.3, .06, .03), this.M(WT.white, { roughness: .4 }), 0, 1.45, 0); [-.9, .9].forEach((lx) => A(wb, box(.05, .8, .05, .01), mt.met, lx, .4, 0));
      [WT.yellow, WT.green, WT.blueLt, WT.yellow, WT.white, WT.green].forEach((c, k) => A(wb, box(.24, .24, .02, .01), this.M(c), -.7 + (k % 3) * .45, 1.7 - Math.floor(k / 3) * .4, .04, { cast: false }));
      A(work, box(1.6, .7, .5, .04), mt.case, px + 4.6, .35, pz + 3.2);
      this.plant(work, px + 4.6, pz - 3.2, .9);
      const busy = pod.desks.filter((d) => d.state !== 'idle').length;
      const free = !pod.lane;
      this.label(pod.label, free ? 'ready for new sessions' : `${pod.desks.length} session${pod.desks.length === 1 ? '' : 's'} · ${busy} busy`, new THREE.Vector3(px, 3.2, pz - 3.6), free ? undefined : () => this.events.onArea(pod.lane), [px - 5.2, pz - 3.8, px + 5.2, pz + 3.8]);
    });

    // rooms column on the right: lead office, conference, lounge
    const lead = this.zone(450);
    const lr = this.glassRoom(lead, xRooms, -D / 2 + 5, 11, 8);
    this.desk(lr, m.lead, 0, -1.4, 0, 1, true);
    A(lr, box(2.2, .5, .9, .1), this.M(WT.blue, { roughness: 1 }), 3.2, .25, 2.4); A(lr, box(2.2, .5, .25, .1), this.M(WT.blue, { roughness: 1 }), 3.2, .65, 2.85);
    this.plant(lr, -4.6, -3.2, 1.2); this.plant(lr, 4.6, -3.2, 1);
    this.label('Lead office', m.lead ? m.lead.name : 'no lead set', new THREE.Vector3(xRooms, 3.6, -D / 2 + 1.2), m.lead ? () => this.events.onSelect(m.lead!.name) : undefined, [xRooms - 5.5, -D / 2 + 1, xRooms + 5.5, -D / 2 + 9]);

    const conf = this.zone(600);
    const cr = this.glassRoom(conf, xRooms, -2, 11, 7);
    A(cr, box(5.6, .1, 1.9, .05), mt.deskTop, 0, .78, 0); [-2.4, 2.4].forEach((lx) => A(cr, box(.12, .74, 1.4, .03), mt.met, lx, .37, 0));
    for (let i = 0; i < 4; i++) { this.chair(cr, -2.1 + i * 1.4, -1.4, Math.PI); this.chair(cr, -2.1 + i * 1.4, 1.4, 0); }
    const ccv = document.createElement('canvas'); ccv.width = 512; ccv.height = 256; const ctex = new THREE.CanvasTexture(ccv); ctex.colorSpace = THREE.SRGBColorSpace;
    A(cr, box(3.4, 1.9, .08, .03), mt.tv, 0, 1.6, -3.1); A(cr, new THREE.PlaneGeometry(3.2, 1.7), new THREE.MeshBasicMaterial({ map: ctex, toneMapped: false }), 0, 1.6, -3.05, { cast: false });
    this.confScreen = { c: ccv.getContext('2d')!, tex: ctex };
    this.label('Conference', 'the team at a glance', new THREE.Vector3(xRooms, 3.6, -5.6), undefined, [xRooms - 5.5, -5.5, xRooms + 5.5, 1.5]);

    const chill = this.zone(750);
    const lz = 10;
    A(chill, new THREE.CylinderGeometry(4.4, 4.4, .04, 48), this.M('#F3E6D3', { roughness: 1 }), xRooms, .09, lz, { cast: false });
    const sofa = this.M(WT.blue, { roughness: 1 });
    A(chill, box(4.2, .55, 1.1, .12), sofa, xRooms, .3, lz + 1.9); A(chill, box(4.2, .75, .3, .12), sofa, xRooms, .75, lz + 2.4);
    A(chill, box(1.1, .55, 2.4, .12), sofa, xRooms - 2.6, .3, lz + 1.2); A(chill, box(.3, .75, 2.4, .12), sofa, xRooms - 3.05, .75, lz + 1.2);
    A(chill, box(1.5, .35, .8, .08), mt.deskTop, xRooms, .3, lz + .3);
    A(chill, box(3.8, .45, .7, .06), mt.case, xRooms, .23, lz - 2.6); A(chill, box(3.4, 1.95, .1, .04), mt.tv, xRooms, 1.65, lz - 2.85);
    const gcv = document.createElement('canvas'); gcv.width = 640; gcv.height = 360; const gtex = new THREE.CanvasTexture(gcv); gtex.colorSpace = THREE.SRGBColorSpace;
    A(chill, new THREE.PlaneGeometry(3.2, 1.8), new THREE.MeshBasicMaterial({ map: gtex, toneMapped: false }), xRooms, 1.65, lz - 2.79, { cast: false });
    this.game = { c: gcv.getContext('2d')!, tex: gtex };
    const ps = new THREE.Group(); ps.position.set(xRooms + 1.2, .45, lz - 2.55); chill.add(ps);
    A(ps, box(.12, .62, .4, .05), this.M('#F7F7F9', { roughness: .35 }), -.07, .31, 0); A(ps, box(.12, .62, .4, .05), this.M('#F7F7F9', { roughness: .35 }), .07, .31, 0); A(ps, box(.06, .6, .36, .02), mt.bezel, 0, .31, 0);
    [[-1.4, -1, WT.yellow], [1.6, -.8, WT.green]].forEach(([dx, dz, c]) => { const b = A(chill, new THREE.SphereGeometry(.65, 20, 14), this.M(c as string, { roughness: 1 }), xRooms + (dx as number), .4, lz + (dz as number)); b.scale.set(1, .62, 1); });
    this.plant(chill, xRooms + 4, lz - 2.6, 1.3); this.plant(chill, xRooms - 4, lz - 2.6, 1.1);
    // ping-pong in the games strip
    const ppx = gameX, ppz = 5;
    A(chill, box(1.5, .08, 2.8, .02), this.M(WT.blueDk, { roughness: .4 }), ppx, .78, ppz); A(chill, box(1.5, .18, .02, .01), mt.case, ppx, .9, ppz);
    A(chill, box(1.5, .005, .03, .002), mt.case, ppx, .825, ppz - .7, { cast: false }); A(chill, box(.03, .005, 2.8, .002), mt.case, ppx, .825, ppz, { cast: false });
    [-1.2, 1.2].forEach((lz2) => A(chill, box(1.2, .74, .08, .02), mt.met, ppx, .37, ppz + lz2));
    // idle sessions spread out: the sofa, ping-pong, pool, the coffee bar, the arcade and foosball, one area after
    // another so a few idle sessions do not all land on the sofa. Spots go by name, so nobody swaps on a refresh.
    type Spot = { x: number; z: number; ry: number; seated: boolean; y?: number; act: string; where: string };
    const onSofa = (dx: number, dz: number, ry: number): Spot => ({ x: xRooms + dx, z: lz + dz, ry, seated: true, act: 'sofa', where: 'lounge' });
    const stool = (i: number): Spot => ({ x: cx - 1.6 + i * 1.3, z: -D / 2 + 2.2, ry: Math.PI, seated: true, y: .26, act: 'coffee', where: 'coffee bar' });
    const byArea: Spot[][] = [
      [{ ...onSofa(0, 1.9, Math.PI), act: 'tv' }, onSofa(-1, 1.9, Math.PI), onSofa(1, 1.9, Math.PI), onSofa(-2.6, .9, Math.PI / 2), onSofa(-1.4, -1, Math.PI * .75), onSofa(1.6, -.8, -Math.PI * .75), onSofa(-2.6, 1.9, Math.PI / 2)],
      [{ x: ppx, z: ppz - 1.95, ry: 0, seated: false, act: 'pingpong', where: 'ping-pong' }, { x: ppx, z: ppz + 1.95, ry: Math.PI, seated: false, act: 'pingpong', where: 'ping-pong' }],
      [{ x: gameX - 1.42, z: -5.5, ry: Math.PI / 2, seated: false, act: 'pool', where: 'pool' }, { x: gameX, z: -7.8, ry: 0, seated: false, act: 'pool', where: 'pool' }],
      [stool(0), stool(1), stool(2)],
      [{ x: gameX + 1.1, z: 9.75, ry: 0, seated: false, act: 'arcade', where: 'arcade' }],
      [{ x: gameX - .78, z: -.4, ry: Math.PI / 2, seated: false, act: 'foos', where: 'foosball' }, { x: gameX + .78, z: -.4, ry: -Math.PI / 2, seated: false, act: 'foos', where: 'foosball' }],
    ];
    const spots: Spot[] = [];
    for (let k = 0; spots.length < byArea.flat().length; k++) for (const area of byArea) if (area[k]) spots.push(area[k]);
    const idleSorted = m.idle.slice().sort((a, b) => a.name.localeCompare(b.name));
    idleSorted.slice(0, spots.length).forEach((d, i) => {
      const sp = spots[i];
      const who = this.person(chill, sp.x, sp.z, sp.ry, sp.seated); if (sp.y) who.g.position.y = sp.y;
      if (sp.act === 'tv') this.gamers.push(who);
      const ring = this.ring(chill, d.state, sp.x, sp.z, .5);
      this.hitBox(chill, d.name, sp.x, 1, sp.z, 1.2, 2, 1.2);
      this.placed.set(d.name, { desk: { ...d, lane: `${d.lane} · ${sp.where}` }, group: who.g, anchor: new THREE.Vector3(0, 2.4, 0), ring, who, act: sp.act });
      this.hoverable(who.g, d.name);
    });
    const more = m.idle.length - spots.length;
    this.label('Lounge', m.idle.length ? `${m.idle.length} idle around the floor${more > 0 ? ` · ${more} not shown` : ''}` : 'nobody idle', new THREE.Vector3(xRooms, 3.4, lz - 3.4), m.idle.length ? () => this.events.onArea('__idle') : undefined, [xRooms - 5, lz - 4.4, xRooms + 5, lz + 4.4]);

    // games strip in the middle of the floor: pool table (ping-pong is just below it)
    const games = this.zone(850);
    const pool = new THREE.Group(); pool.position.set(gameX, 0, -5.5); pool.rotation.y = Math.PI / 2; games.add(pool);
    const felt = this.M(WT.green, { roughness: 1 }), railM = this.M('#8A5A34', { roughness: .45 }), rail = () => railM;
    A(pool, box(2.6, .14, 1.45, .03), felt, 0, .84, 0);
    for (const [rx, rz, rw, rd] of [[0, -.78, 2.8, .16], [0, .78, 2.8, .16], [-1.36, 0, .16, 1.45], [1.36, 0, .16, 1.45]] as const) A(pool, box(rw, .14, rd, .03), railM, rx, .88, rz);
    for (const [lx, lz2] of [[-1.15, -.55], [1.15, -.55], [-1.15, .55], [1.15, .55]]) A(pool, box(.14, .78, .14, .03), railM, lx, .39, lz2);
    [WT.yellow, WT.blue, '#E5484D', '#2F3A55', '#F97316', WT.green, '#7C3AED', '#F7F8FB'].forEach((c, i) => {
      const row = i < 1 ? 0 : i < 3 ? 1 : i < 6 ? 2 : 3, k = i - [0, 1, 3, 6][row];
      A(pool, new THREE.SphereGeometry(.05, 14, 10), this.M(c, { roughness: .2 }), i === 7 ? -.8 : .5 + row * .09, .96, i === 7 ? 0 : (k - row / 2) * .1);
    });
    for (const sg of [-1, 1]) { const cue = A(pool, new THREE.CylinderGeometry(.012, .02, 1.4, 8), railM, -.2 + sg * .5, .99, sg * .35); cue.rotation.z = Math.PI / 2; cue.rotation.y = sg * .3; }
    // the whole strip reads as one area: a long rug and low planters along both edges
    A(games, box(6.2, .03, D - 4, .01), this.M('#E8EEF7', { roughness: 1 }), gameX, .085, 0, { cast: false });
    for (const side of [-1, 1]) for (const z0 of [-11, -3.5, 4.5, 11]) {
      const px = gameX + side * 3.35;
      A(games, box(.5, .45, 3.2, .06), mt.case, px, .23, z0);
      for (let k = -1; k <= 1; k++) A(games, new THREE.SphereGeometry(.3, 12, 10), mt.plant, px, .6, z0 + k * .95);
    }
    // back: a vending machine and a water cooler
    const vend = new THREE.Group(); vend.position.set(gameX - 1.2, 0, -D / 2 + 1.6); games.add(vend);
    A(vend, box(1.1, 1.95, .8, .06), mt.case, 0, .98, 0); A(vend, box(.82, 1.4, .02, .02), this.M('#1B2233', { roughness: .15, metalness: .3 }), -.08, 1.15, .41, { cast: false });
    [WT.yellow, WT.blue, '#E5484D', WT.green].forEach((c, r) => { for (let k = 0; k < 4; k++) A(vend, box(.14, .2, .02, .01), this.M(c), -.36 + k * .19, 1.6 - r * .3, .43, { cast: false }); });
    const cool = new THREE.Group(); cool.position.set(gameX + 1.4, 0, -D / 2 + 1.6); games.add(cool);
    A(cool, box(.5, 1, .5, .06), mt.case, 0, .5, 0); A(cool, new THREE.CylinderGeometry(.2, .2, .5, 20), this.M('#9FC3F5', { transparent: true, opacity: .7, roughness: .1 }), 0, 1.25, 0);
    // a bench beside the pool table for whoever is watching
    A(games, box(.5, .08, 2.4, .03), mt.deskTop, gameX + 2.1, .48, -5.5); [-1, 1].forEach((k) => A(games, box(.4, .44, .08, .02), mt.met, gameX + 2.1, .22, -5.5 + k * 1));
    // foosball between pool and ping-pong
    const foos = new THREE.Group(); foos.position.set(gameX, 0, -.4); foos.rotation.y = Math.PI / 2; games.add(foos);
    A(foos, box(1.25, .22, .72, .03), rail(), 0, .86, 0); A(foos, box(1.15, .02, .62, .01), felt, 0, .97, 0, { cast: false });
    for (const [lx, lz2] of [[-.5, -.28], [.5, -.28], [-.5, .28], [.5, .28]]) A(foos, box(.08, .76, .08, .02), rail(), lx, .38, lz2);
    for (let r = 0; r < 6; r++) { const rx = -.5 + r * .2; const rod = A(foos, new THREE.CylinderGeometry(.012, .012, 1.0, 8), mt.met, rx, 1.02, 0); rod.rotation.x = Math.PI / 2;
      for (let k = -1; k <= 1; k += 2) A(foos, box(.05, .12, .05, .01), this.M(r % 2 ? WT.blue : WT.yellow), rx, .98, k * .14); }
    // front: two arcade cabinets and a tall table
    for (const k of [-1, 1]) {
      const cab = new THREE.Group(); cab.position.set(gameX + k * 1.1, 0, 10.6); cab.rotation.y = Math.PI; games.add(cab);
      A(cab, box(.72, 1.75, .7, .04), this.M(k < 0 ? WT.blue : WT.blueDk), 0, .88, 0);
      A(cab, box(.74, .18, .72, .03), this.M(WT.yellow), 0, 1.84, 0);
      const scr = A(cab, new THREE.PlaneGeometry(.56, .42), new THREE.MeshBasicMaterial({ color: k < 0 ? '#FF5FA2' : '#7FD8FF', toneMapped: false }), 0, 1.38, .36, { cast: false }); scr.rotation.x = -.18;
      A(cab, box(.66, .06, .3, .02), mt.bezel, 0, 1.0, .42);
    }
    this.label('Games', 'pool · foosball · ping-pong · arcade', new THREE.Vector3(gameX, 2.6, -2.6), undefined, [gameX - 3.5, -D / 2 + 2.6, gameX + 3.5, D / 2 - 2.2]);

    // entrance: a doormat and two plants at the gap in the front wall
    const ent = this.zone(900);
    A(ent, box(2.4, .02, 1.4, .01), this.M('#2F3A55', { roughness: 1 }), entX, .09, D / 2 - .9, { cast: false });
    this.plant(ent, entX + 2, D / 2 - 1.1, 1.2); this.plant(ent, entX - 2, D / 2 - 1.1, 1);
    this.label('Entrance', '', new THREE.Vector3(entX, 2.4, D / 2 - .6), undefined, [entX - 2.6, D / 2 - 2.2, entX + 2.6, D / 2]);

    // the gym: the real people who run ShiftBoss, enjoying themselves while the agents work
    const gym = this.zone(980);
    const gx0 = x0 + 2.2, gx1 = x0 + 1.5 + workW - .4, gcx = (gx0 + gx1) / 2, gz = D / 2 - 3.6;
    A(gym, box(gx1 - gx0, .03, 5.4, .01), this.M('#2F3A55', { roughness: 1 }), gcx, .09, gz, { cast: false });
    // treadmill, with the owner on it
    const tm = new THREE.Group(); tm.position.set(gcx - 3.6, 0, gz); gym.add(tm);
    A(tm, box(.9, .22, 2.1, .06), mt.bezel, 0, .12, 0); A(tm, box(.7, .02, 1.7, .01), this.M('#3A3F4A', { roughness: .9 }), 0, .24, .05, { cast: false });
    for (const sx of [-.4, .4]) A(tm, box(.06, 1.1, .06, .02), mt.met, sx, .7, -.9);
    A(tm, box(.9, .32, .1, .03), mt.bezel, 0, 1.3, -.92); A(tm, new THREE.PlaneGeometry(.5, .2), new THREE.MeshBasicMaterial({ color: '#7FD8FF', toneMapped: false }), 0, 1.33, -.865, { cast: false });
    // bench press with a loaded barbell
    A(gym, box(.42, .42, 1.4, .06), this.M(WT.blue), gcx - .8, .3, gz); A(gym, box(.36, .55, .1, .03), this.M(WT.blue), gcx - .8, .55, gz - .62);
    for (const sx of [-.5, .5]) A(gym, box(.06, 1.2, .06, .02), mt.met, gcx - .8 + sx, .6, gz - .5);
    const bar = A(gym, new THREE.CylinderGeometry(.025, .025, 1.9, 10), mt.met, gcx - .8, 1.12, gz - .5); bar.rotation.z = Math.PI / 2;
    for (const sx of [-.82, .82]) { const plate = A(gym, new THREE.CylinderGeometry(.24, .24, .08, 24), mt.bezel, gcx - .8 + sx, 1.12, gz - .5); plate.rotation.z = Math.PI / 2; }
    // dumbbell rack
    A(gym, box(1.6, .5, .5, .04), mt.met, gcx + 1.6, .45, gz - 1.6);
    for (let i = 0; i < 5; i++) { const db = A(gym, new THREE.CylinderGeometry(.05, .05, .36, 10), mt.bezel, gcx + 1 + i * .3, .78, gz - 1.6); db.rotation.x = Math.PI / 2; }
    // punching bag on a stand, yoga mats
    A(gym, box(.08, 2.3, .08, .02), mt.met, gcx + 3.9, 1.15, gz + .4); A(gym, box(.9, .08, .08, .02), mt.met, gcx + 3.5, 2.28, gz + .4);
    A(gym, new THREE.CylinderGeometry(.24, .24, 1.05, 20), this.M(WT.yellow, { roughness: .8 }), gcx + 3.1, 1.5, gz + .4);
    [[gcx + 1.4, gz + 1.2, WT.green], [gcx + 2.4, gz + 1.2, WT.blueLt]].forEach(([x, z, c]) => A(gym, box(.7, .02, 1.8, .01), this.M(c as string, { roughness: 1 }), x as number, .11, z as number, { cast: false }));
    this.label('Gym', 'for the humans', new THREE.Vector3(gcx, 2.6, gz - 1.6), undefined, [gx0, gz - 2.7, gx1, gz + 2.7]);
    // the owner wanders between these, at random
    this.ownerSpots = [
      { x: gcx - 3.6, z: gz + .1, y: .24, ry: Math.PI, act: 'run', what: 'on the treadmill' },
      { x: gcx - .8, z: gz + 1.15, y: 0, ry: Math.PI, act: 'lift', what: 'lifting at the bench' },
      { x: gcx + 3.1, z: gz + 1.25, y: 0, ry: Math.PI, act: 'box', what: 'on the punching bag' },
      { x: gcx + 1.4, z: gz + 1.2, y: 0, ry: Math.PI, act: 'stretch', what: 'stretching on the mat' },
      { x: gameX + 1.42, z: -5.5, y: 0, ry: -Math.PI / 2, act: 'pool', what: 'playing pool' },
      { x: gameX - 1.1, z: 9.75, y: 0, ry: 0, act: 'arcade', what: 'on the arcade' },
      { x: cx + 1.4, z: -D / 2 + 2.4, y: 0, ry: Math.PI, act: 'coffee', what: 'getting a coffee' },
    ];
    this.ownerAt = Math.floor(Math.random() * this.ownerSpots.length);
    const sp = this.ownerSpots[this.ownerAt];
    this.owner = this.person(this.world, sp.x, sp.z, sp.ry, false); this.owner.g.position.y = sp.y;
    const ownerHit = this.add(this.owner.g, new THREE.BoxGeometry(1, 2.2, 1), new THREE.MeshBasicMaterial({ visible: false }), 0, 1.1, 0, { cast: false, recv: false });
    ownerHit.userData.session = '__owner'; this.clickables.push(ownerHit);
    this.hoverable(this.owner.g, '__owner');
    this.placed.set('__owner', { desk: { name: this.wallData.owner || 'You', lane: 'you', state: 'finished', task: null, ctx: 0, cacheRead: 0, lastTool: null, lines: [] }, group: this.owner.g, anchor: new THREE.Vector3(0, 2.3, 0) });
    this.ownerNext = performance.now() + 40_000 + Math.random() * 40_000;

    for (const p of this.placed.values()) this.syncPin(p);
    if (!this.intro) for (const [name, p] of this.placed) {
      const from = was.get(name); if (!p.who || !from) continue;
      const to = p.who.g.getWorldPosition(new THREE.Vector3()); if (from.distanceTo(to) < 1.5) continue;
      const aisle = -.3, path = new THREE.CurvePath<THREE.Vector3>();
      const pts = [from.clone().setY(0), new THREE.Vector3(from.x, 0, aisle), new THREE.Vector3(to.x, 0, aisle), to.clone().setY(0)];
      for (let i = 0; i < pts.length - 1; i++) if (pts[i].distanceTo(pts[i + 1]) > .01) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
      const walker = this.person(this.world, from.x, from.z, 0, false); this.hoverable(walker.g, name);
      p.who.g.visible = false;
      this.trips.push({ who: walker, path, t0: performance.now(), dur: path.getLength() / 1.4 * 1000, target: p.who });
    }
    // camera: the whole floor in view
    const dist = Math.max(32, W * .92, D * 1.12);
    this.home.pos.set(dist * .55, dist * .62, dist * .68); this.home.target.set(0, 0, 1);
    this.controls.maxDistance = dist * 1.8;
    if (this.intro) {
      this.camera.position.copy(this.home.pos).multiplyScalar(1.6); this.controls.target.copy(this.home.target);
      if (reduced) this.camera.position.copy(this.home.pos); else this.flyTo(this.home.pos, this.home.target, 2600);
      for (const z of this.zones) if (!reduced && z.delay) z.g.position.y = -6;
      this.t0 = performance.now();
    }
    this.drawConf();
  }

  // ---------- screens that are not desks ----------
  private drawConf() {
    const s = this.confScreen, m = this.model; if (!s || !m) return;
    const { c } = s; c.fillStyle = '#0b0b0c'; c.fillRect(0, 0, 512, 256);
    c.fillStyle = '#f4f4f5'; c.font = '500 40px Geist, sans-serif'; c.fillText(`${m.kpis.busy} of ${m.kpis.total} busy`, 32, 84);
    c.fillStyle = 'rgba(255,255,255,.55)'; c.font = '26px "Geist Mono", monospace'; c.fillText(`${m.kpis.inProgress} in progress · ${m.kpis.shippedToday} live today`, 32, 136);
    c.fillStyle = m.kpis.needs ? '#FF5A4F' : '#4ADE80'; c.fillText(m.kpis.needs ? `${m.kpis.needs} need you` : 'nothing waits on you', 32, 186);
    s.tex.needsUpdate = true;
  }
  private drawWall(w: { c: CanvasRenderingContext2D; tex: THREE.CanvasTexture; kind: string }, t: number) {
    const { c } = w, W = 320, H = 180, d = this.wallData, m = this.model;
    c.fillStyle = '#0B0B0D'; c.fillRect(0, 0, W, H);
    const title = (s: string, col = 'rgba(255,255,255,.55)') => { c.fillStyle = col; c.font = '500 14px Geist, sans-serif'; c.fillText(s.toUpperCase(), 14, 24); };
    c.font = '13px "Geist Mono", monospace';
    if (w.kind === 'release') {
      title('Deployed');
      (d.envs.length ? d.envs : [{ env: 'no releases tracked', version: '' }]).slice(0, 4).forEach((e, i) => { c.fillStyle = '#4ADE80'; c.fillRect(14, 44 + i * 30, 8, 8); c.fillStyle = 'rgba(255,255,255,.8)'; c.fillText(`${e.env}  ${e.version}`.slice(0, 34), 30, 52 + i * 30); });
    } else if (w.kind === 'alert') {
      const bad = !!d.alert, on = Math.sin(t * 4) > -.3;
      if (bad) { c.fillStyle = on ? 'rgba(255,90,79,.16)' : 'rgba(255,90,79,.06)'; c.fillRect(0, 0, W, H); }
      title(bad ? 'Monitor · bad' : 'Monitors', bad ? '#FF5A4F' : undefined);
      c.fillStyle = bad ? '#F4F4F5' : '#4ADE80'; c.font = '500 17px Geist, sans-serif';
      const txt = bad ? d.alert! : 'all fine'; for (let i = 0; i < 3; i++) c.fillText(txt.slice(i * 26, (i + 1) * 26), 14, 70 + i * 24);
    } else if (w.kind === 'usage') {
      title('Usage');
      ([['5 hours', d.usage5h], ['week', d.usageWeek]] as [string, number | null][]).forEach(([k, v], i) => { c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(14, 56 + i * 52, W - 28, 12); c.fillStyle = v === null ? 'rgba(255,255,255,.2)' : v >= 85 ? '#FF5A4F' : v >= 70 ? '#F5A524' : '#F4F4F5'; c.fillRect(14, 56 + i * 52, (W - 28) * Math.min(1, (v ?? 0) / 100), 12); c.fillStyle = 'rgba(255,255,255,.7)'; c.fillText(`${k}  ${v === null ? '—' : Math.round(v) + '%'}`, 14, 50 + i * 52); });
    } else if (w.kind === 'feed') {
      title('Live');
      (d.feed.length ? d.feed : ['quiet']).slice(0, 6).forEach((l, i) => { c.fillStyle = 'rgba(255,255,255,.72)'; c.fillText(l.slice(0, 36), 14, 48 + i * 21); });
    } else if (w.kind === 'sessions' && m) {
      title(`Sessions · ${m.all.length}`);
      (['working', 'needs', 'stuck', 'finished', 'idle'] as DeskState[]).forEach((st, i) => { const v = m.all.filter((x) => x.state === st).length; c.fillStyle = DESK_COLOR[st]; c.fillRect(14, 40 + i * 26, Math.max(4, v * 22), 14); c.fillStyle = 'rgba(255,255,255,.7)'; c.fillText(`${v} ${DESK_WORD[st]}`, 22 + Math.max(4, v * 22), 52 + i * 26); });
    } else if (m) {
      const top = m.all.slice().sort((a, b) => b.cacheRead - a.cacheRead)[0];
      title('Most cache read');
      if (top) { const red = top.cacheRead >= 1e9; c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(14, 70, W - 28, 16); c.fillStyle = red ? '#FF5A4F' : top.cacheRead >= 5e8 ? '#F5A524' : '#F4F4F5'; c.fillRect(14, 70, (W - 28) * Math.min(1, top.cacheRead / 1.2e9), 16); c.font = '500 24px "Geist Mono", monospace'; c.fillText(fmtCache(top.cacheRead), 14, 128); c.font = '13px "Geist Mono", monospace'; c.fillStyle = 'rgba(255,255,255,.6)'; c.fillText(top.name.slice(0, 30), 14, 154); }
    }
    w.tex.needsUpdate = true;
  }
  private drawGame(t: number) { // the lounge TV: an open-world drive at sunset (our own scene)
    const g = this.game; if (!g) return; t = Math.max(0, t); const c = g.c, W = 640, H = 360, hor = 200;
    const sky = c.createLinearGradient(0, 0, 0, hor); sky.addColorStop(0, '#2B1055'); sky.addColorStop(.55, '#D53F8C'); sky.addColorStop(1, '#FFB36B');
    c.fillStyle = sky; c.fillRect(0, 0, W, hor); c.fillStyle = '#FFE29A'; c.beginPath(); c.arc(W / 2, hor - 10, 58, Math.PI, 0); c.fill();
    const off = (t * 18) % W; c.fillStyle = '#3A1A5E';
    for (let k = -1; k < 2; k++) for (let i = 0; i < 16; i++) { const bw = 26 + (i * 37) % 22, bh = 40 + (i * 53) % 70; c.fillRect(i * 42 - off + k * W, hor - bh, bw, bh); }
    c.fillStyle = '#1E7FA8'; c.fillRect(0, hor, W, 40);
    c.fillStyle = '#2E2A3A'; c.beginPath(); c.moveTo(W / 2 - 20, hor + 40); c.lineTo(W / 2 + 20, hor + 40); c.lineTo(W, H); c.lineTo(0, H); c.fill();
    c.fillStyle = '#FFD166'; for (let i = 0; i < 6; i++) { const z = (i / 6 + t * .9) % 1, y = hor + 40 + z * z * (H - hor - 40); c.fillRect(W / 2 - (2 + z * 10) / 2, y, 2 + z * 10, 4 + z * 22); }
    for (let i = 0; i < 3; i++) { const z = (i / 3 + t * .55) % 1, sc = .3 + z * 2.2, y = hor + 40 + z * z * (H - hor - 40);
      for (const side of [-1, 1]) { const x = W / 2 + side * (60 + z * z * 320); c.strokeStyle = '#1B0F2E'; c.lineWidth = 3 * sc; c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + side * 6 * sc, y - 40 * sc, x, y - 70 * sc); c.stroke();
        c.fillStyle = '#1B0F2E'; for (let a = 0; a < 6; a++) { c.beginPath(); c.ellipse(x + Math.cos(a) * 16 * sc, y - 70 * sc + Math.sin(a) * 5 * sc, 18 * sc, 4 * sc, a, 0, Math.PI * 2); c.fill(); } } }
    const cx = W / 2 + Math.sin(t * 1.3) * 26; c.fillStyle = '#2D5BE3'; c.fillRect(cx - 56, 282, 112, 34); c.fillStyle = '#2349C4'; c.fillRect(cx - 40, 262, 80, 24); c.fillStyle = '#7FD8FF'; c.fillRect(cx - 34, 266, 68, 14);
    c.fillStyle = '#FF3B3B'; c.fillRect(cx - 52, 292, 18, 7); c.fillRect(cx + 34, 292, 18, 7);
    c.fillStyle = 'rgba(0,0,0,.55)'; c.beginPath(); c.arc(52, H - 52, 38, 0, Math.PI * 2); c.fill();
    c.font = 'bold 22px Geist, sans-serif'; c.fillStyle = '#FFFFFF'; c.textAlign = 'right'; c.fillText('$ 1,284,600', W - 18, 34); c.fillStyle = '#FFD166'; c.fillText('★ ★ ☆ ☆ ☆', W - 18, 62);
    c.font = 'bold 30px "Geist Mono", monospace'; c.fillStyle = '#FFFFFF'; c.fillText(Math.round(118 + Math.sin(t * .7) * 9) + ' mph', W - 18, H - 22); c.textAlign = 'left';
    g.tex.needsUpdate = true;
  }

  // ---------- input ----------
  private onMove = (e: PointerEvent) => {
    this.lastMove = performance.now();
    this.ptr.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    this.ray.setFromCamera(this.ptr, this.camera);
    const hit = this.ray.intersectObjects(this.clickables, false)[0];
    this.hovered = hit ? hit.object.userData.session : null;
    const at = this.ray.ray.intersectPlane(this.floorPlane, new THREE.Vector3());
    this.hoveredArea = at ? this.labels.find((l) => l.area && at.x >= l.area[0] && at.x <= l.area[2] && at.z >= l.area[1] && at.z <= l.area[3]) ?? null : null;
    this.canvas.style.cursor = this.hovered || this.hoveredArea?.onClick ? 'pointer' : this.downAt ? 'grabbing' : 'grab';
  };
  private onDown = (e: PointerEvent) => { this.downAt = [e.clientX, e.clientY]; };
  private onUp = (e: PointerEvent) => {
    if (this.downAt && Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) < 5 && this.hovered && this.hovered !== '__owner') this.events.onSelect(this.hovered);
    else if (this.downAt && Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) < 5 && !this.hovered && this.hoveredArea?.onClick) this.hoveredArea.onClick();
    this.downAt = null;
  };
  private onLeave = () => { this.hovered = null; this.hoveredArea = null; };

  // ---------- camera and frame ----------
  private flyTo(pos: THREE.Vector3, target: THREE.Vector3, ms = 1400) { this.fly = { from: this.camera.position.clone(), to: pos.clone(), tFrom: this.controls.target.clone(), tTo: target.clone(), t0: performance.now(), ms }; }
  private resize() {
    this.renderer.setSize(innerWidth, innerHeight, false); this.composer?.setSize(innerWidth, innerHeight); this.camera.aspect = innerWidth / innerHeight;
    // the right panel covers about 390 px: shift the view so the floor sits in the middle of what is left
    const shift = innerWidth > 1100 ? 190 : 0;
    if (shift) this.camera.setViewOffset(innerWidth, innerHeight, shift, -20, innerWidth, innerHeight); else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }
  private toScreen(v: THREE.Vector3) { const p = v.clone().project(this.camera); return { x: (p.x * .5 + .5) * innerWidth, y: (-p.y * .5 + .5) * innerHeight, behind: p.z > 1 }; }

  private loop = (now: number) => {
    if (this.disposed || document.hidden) return;
    this.raf = requestAnimationFrame(this.loop);
    if (now - this.lastFrame < 1000 / 30) return; // 30 fps is plenty for a screen that stays open
    const dt = Math.min((now - this.lastFrame) / 1000, .1); this.lastFrame = now;
    const t = Math.max(0, (now - this.t0) / 1000); // a rebuild can set t0 a moment after this frame began
    const ease = (k: number) => 1 - Math.pow(1 - k, 4);
    if (this.intro && !reduced) { let done = true; for (const z of this.zones) { if (!z.delay) continue; const k = Math.min(1, Math.max(0, (t * 1000 - 400 - z.delay) / 900)); z.g.position.y = -6 * (1 - ease(k)); if (k < 1) done = false; } if (done && this.zones.length) this.intro = false; }
    else if (this.zones.length) this.intro = false;
    if (this.fly) { const k = Math.min(1, (now - this.fly.t0) / this.fly.ms), e = ease(k); this.camera.position.lerpVectors(this.fly.from, this.fly.to, e); this.controls.target.lerpVectors(this.fly.tFrom, this.fly.tTo, e); if (k >= 1) this.fly = null; }
    this.controls.autoRotate = !reduced && !this.fly && !this.selected && now - this.lastMove > 8000; this.controls.autoRotateSpeed = .3;
    this.controls.update();
    if (!reduced) {
      for (const [name, p] of this.placed) {
        const st = p.desk.state;
        if (p.term && (t * 8 | 0) !== (p.term.frame | 0)) { p.term.frame = t * 8; this.drawTerm(p.term, t); }
        if (p.who?.armL && st === 'working' && p.term) { const k = t * 11 + name.length; p.who.armL.rotation.x = -1.0 + Math.sin(k) * .09; p.who.armR!.rotation.x = -1.0 + Math.sin(k + 1.7) * .09; p.who.head.rotation.x = Math.sin(t * .8 + name.length) * .06; }
        if (p.ring) { const mm = p.ring.material as THREE.MeshBasicMaterial; if (st === 'needs') { mm.opacity = .35 + Math.abs(Math.sin(t * 3)) * .55; p.ring.scale.setScalar(1 + Math.abs(Math.sin(t * 3)) * .15); } else if (st === 'stuck') mm.opacity = .3 + Math.abs(Math.sin(t * 1.4)) * .4; }
      }
      for (const gm of this.gamers) { gm.body.rotation.z = Math.sin(t * 2.2) * .05; }
      for (const [name, p] of this.placed) {
        if (!p.act || !p.who) continue;
        const w = p.who, ph = name.length * .7;
        if (p.act === 'pingpong') { w.armR!.rotation.x = -1.1 + Math.sin(t * 4 + ph) * .5; w.body.rotation.y = Math.sin(t * 4 + ph) * .15; }
        else if (p.act === 'pool') { w.body.rotation.x = .2; w.armL!.rotation.x = -1.2; w.armR!.rotation.x = -1.1 + Math.sin(t * 1.2 + ph) * .25; }
        else if (p.act === 'arcade' || p.act === 'foos') { w.armL!.rotation.x = -1.05 + Math.sin(t * 14 + ph) * .06; w.armR!.rotation.x = -1.05 + Math.sin(t * 12 + ph) * .08; }
        else if (p.act === 'coffee') { w.armR!.rotation.x = -1.7 + Math.sin(t * .7 + ph) * .12; }
      }
      if (this.game && (t * 24 | 0) % 1 === 0) this.drawGame(t);
      if ((t * 2 | 0) !== ((t - dt) * 2 | 0)) this.wall.forEach((w) => this.drawWall(w, t));
      this.trips = this.trips.filter((tr) => {
        const k = (now - tr.t0) / tr.dur;
        if (k >= 1) { tr.who.g.removeFromParent(); tr.target.g.visible = true; return false; }
        const p = tr.path.getPointAt(k), q = tr.path.getTangentAt(k), sw = Math.sin(t * 7.5);
        tr.who.legL!.rotation.x = sw * .55; tr.who.legR!.rotation.x = -sw * .55; tr.who.armL!.rotation.x = -sw * .45; tr.who.armR!.rotation.x = sw * .45;
        tr.who.g.position.set(p.x, Math.abs(Math.cos(t * 7.5)) * .06, p.z); tr.who.g.rotation.y = Math.atan2(q.x, q.z);
        return true;
      });
      if (this.owner && this.ownerSpots.length) {
        const o = this.owner, L = o.legL!, R = o.legR!, AL = o.armL!, AR = o.armR!;
        L.rotation.x = R.rotation.x = AL.rotation.x = AR.rotation.x = 0; o.body.position.y = 0; o.body.rotation.x = 0;
        if (!this.ownerTrip && now >= this.ownerNext) {
          let to = this.ownerAt; while (to === this.ownerAt) to = Math.floor(Math.random() * this.ownerSpots.length);
          const a2 = this.ownerSpots[this.ownerAt], b2 = this.ownerSpots[to], aisle = -.3, path = new THREE.CurvePath<THREE.Vector3>();
          const pts = [new THREE.Vector3(a2.x, 0, a2.z), new THREE.Vector3(a2.x, 0, aisle), new THREE.Vector3(b2.x, 0, aisle), new THREE.Vector3(b2.x, 0, b2.z)];
          for (let i = 0; i < 3; i++) if (pts[i].distanceTo(pts[i + 1]) > .01) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
          this.ownerTrip = { path, t0: now, dur: path.getLength() / 1.4 * 1000, to };
        }
        if (this.ownerTrip) {
          const k = Math.min(1, (now - this.ownerTrip.t0) / this.ownerTrip.dur), sw = Math.sin(t * 7.5);
          const p = this.ownerTrip.path.getPointAt(k), q = this.ownerTrip.path.getTangentAt(k);
          L.rotation.x = sw * .55; R.rotation.x = -sw * .55; AL.rotation.x = -sw * .45; AR.rotation.x = sw * .45;
          o.g.position.set(p.x, Math.abs(Math.cos(t * 7.5)) * .06, p.z); o.g.rotation.y = Math.atan2(q.x, q.z);
          if (k >= 1) { this.ownerAt = this.ownerTrip.to; this.ownerTrip = null; const sp = this.ownerSpots[this.ownerAt]; o.g.position.set(sp.x, sp.y, sp.z); o.g.rotation.y = sp.ry; this.ownerNext = now + 60_000 + Math.random() * 90_000; }
        } else {
          const act = this.ownerSpots[this.ownerAt].act;
          if (act === 'run') { const sw = Math.sin(t * 11); L.rotation.x = sw * .7; R.rotation.x = -sw * .7; AL.rotation.x = -sw * .6; AR.rotation.x = sw * .6; o.body.position.y = Math.abs(Math.cos(t * 11)) * .05; }
          else if (act === 'lift') { const up = (Math.sin(t * 1.6) + 1) / 2; AL.rotation.x = AR.rotation.x = -Math.PI + .9 * (1 - up); o.body.position.y = -up * .04; }
          else if (act === 'box') { const k2 = t * 5; AL.rotation.x = -1.45 - Math.max(0, Math.sin(k2)) * .3; AR.rotation.x = -1.45 - Math.max(0, Math.sin(k2 + Math.PI)) * .3; o.body.rotation.x = .08; }
          else if (act === 'stretch') { AL.rotation.x = AR.rotation.x = -2.9; o.body.position.y = Math.sin(t * .9) * .03; o.body.rotation.x = Math.sin(t * .9) * .08; }
          else if (act === 'pool') { o.body.rotation.x = .2; AL.rotation.x = -1.2; AR.rotation.x = -1.1 + Math.sin(t * 1.2) * .25; }
          else if (act === 'arcade') { AL.rotation.x = -1.05 + Math.sin(t * 14) * .05; AR.rotation.x = -1.05 + Math.sin(t * 12 + 1) * .07; }
          else if (act === 'coffee') { AR.rotation.x = -1.7 + Math.sin(t * .7) * .1; o.body.position.y = Math.sin(t * .8) * .01; }
        }
      }
    }
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    // labels, pins and the hover card follow the camera
    for (const l of this.labels) { const s = this.toScreen(l.pos); l.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`; l.el.style.opacity = !s.behind && l === this.hoveredArea && !this.hovered ? '1' : '0'; }
    for (const p of this.placed.values()) if (p.pin) { const s = this.toScreen(p.group.localToWorld(p.anchor.clone().add(new THREE.Vector3(0, .6, 0)))); p.pin.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`; }
    const hv = this.hovered ? this.placed.get(this.hovered) : null;
    if (hv) {
      const s = this.toScreen(hv.group.localToWorld(hv.anchor.clone())), d = hv.desk;
      this.hoverEl.style.display = 'flex'; this.hoverEl.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, calc(-100% - 14px))`;
      this.hoverEl.innerHTML = this.hovered === '__owner'
        ? `<div class="h1"><b>${esc(this.wallData.owner || 'You')}</b><span>you</span></div><div class="h2">${this.ownerTrip ? 'walking over' : esc(this.ownerSpots[this.ownerAt]?.what ?? '')} while the agents work</div>`
        : `<div class="h1"><i class="dot" style="background:${DESK_COLOR[d.state]}"></i><b>${esc(d.name)}</b><span>${DESK_WORD[d.state]}</span></div><div class="h2">${esc(d.task ?? d.lane)} · ctx ${d.ctx}% · cache ${fmtCache(d.cacheRead)}</div>`;
    } else this.hoverEl.style.display = 'none';
  };
}
