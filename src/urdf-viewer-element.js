import * as THREE from 'three';
import { MeshStandardMaterial } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import URDFLoader from './URDFLoader.js';

const emptyRaycast = () => {};

const ev = (name, detail) =>
  new CustomEvent(name, { bubbles: true, cancelable: true, composed: true, detail });

export default class URDFViewer extends HTMLElement {
  static get observedAttributes() {
    return ['package', 'urdf', 'up', 'display-shadow', 'ambient-color', 'ignore-limits', 'show-collision'];
  }

  // small helpers
  _getBoolAttr(name) { return this.hasAttribute(name); }
  _setBoolAttr(name, v) { v ? this.setAttribute(name, '') : this.removeAttribute(name); }
  _setNeedsRender() { this._dirty = true; }

  get package() { return this.getAttribute('package') || ''; }
  set package(v) { this.setAttribute('package', v); }

  get urdf() { return this.getAttribute('urdf') || ''; }
  set urdf(v) { this.setAttribute('urdf', v); }

  get up() { return this.getAttribute('up') || '+Z'; }
  set up(v) { this.setAttribute('up', v); }

  get ambientColor() { return this.getAttribute('ambient-color') || '#8ea0a8'; }
  set ambientColor(v) { v ? this.setAttribute('ambient-color', v) : this.removeAttribute('ambient-color'); }

  get displayShadow() { return this._getBoolAttr('display-shadow'); }
  set displayShadow(v) { this._setBoolAttr('display-shadow', v); }

  get ignoreLimits() { return this._getBoolAttr('ignore-limits'); }
  set ignoreLimits(v) { this._setBoolAttr('ignore-limits', v); }

  get autoRedraw() { return this._getBoolAttr('auto-redraw'); }
  set autoRedraw(v) { this._setBoolAttr('auto-redraw', v); }

  get noAutoRecenter() { return this._getBoolAttr('no-auto-recenter'); }
  set noAutoRecenter(v) { this._setBoolAttr('no-auto-recenter', v); }

  get showCollision() { return this._getBoolAttr('show-collision'); }
  set showCollision(v) { this._setBoolAttr('show-collision', v); }

  get jointValues() {
    const out = {};
    if (this.robot) {
      for (const [name, j] of Object.entries(this.robot.joints)) {
        out[name] = j.jointValue.length === 1 ? j.angle : [...j.jointValue];
      }
    }
    return out;
  }
  set jointValues(v) { this.setJointValues(v); }

  get angles() { return this.jointValues; }
  set angles(v) { this.jointValues = v; }

  constructor() {
    super();
    this._requestId = 0;
    this._dirty = false;
    this._loadScheduled = false;
    this.robot = null;
    this.loadMeshFunc = null;
    this.urlModifierFunc = null;
    this.envMap = null;

    // scene
    const scene = new THREE.Scene();

    const ambientLight = new THREE.HemisphereLight(this.ambientColor, '#000', 1.0);
    ambientLight.groundColor.lerp(ambientLight.color, 0.5 * Math.PI);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, Math.PI);
    dirLight.castShadow = true;
    dirLight.position.set(4, 10, 1);
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.normalBias = 0.001;
    scene.add(dirLight, dirLight.target);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setClearColor(0x263238);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    camera.position.z = -10;

    const world = new THREE.Object3D();
    scene.add(world);

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.ShadowMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.25 }),
    );
    Object.assign(plane, { receiveShadow: true, raycast: emptyRaycast });
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -0.5;
    plane.scale.set(10, 10, 10);
    scene.add(plane);

    const gridHelper = new THREE.GridHelper(5, 100, 0x555555, 0x444444);
    Object.assign(gridHelper, { raycast: emptyRaycast });
    gridHelper.position.y = -0.499;
    gridHelper.material.transparent = true;
    gridHelper.material.opacity = 0.5;
    scene.add(gridHelper);

    const controls = new OrbitControls(camera, renderer.domElement);
    Object.assign(controls, {
      rotateSpeed: 2.0, zoomSpeed: 5, panSpeed: 2, enableZoom: true, enableDamping: false, maxDistance: 50, minDistance: 0.25,
    });
    controls.addEventListener('change', () => this.recenter());

    this.scene = scene;
    this.world = world;
    this.renderer = renderer;
    this.camera = camera;
    this.controls = controls;
    this.plane = plane;
    this.gridHelper = gridHelper;
    this.directionalLight = dirLight;
    this.ambientLight = ambientLight;

    this._collisionMaterial = new MeshStandardMaterial({
      transparent: true, opacity: 0.35, roughness: 0.3, metalness: 0.2,
      premultipliedAlpha: true, color: 0xffbe38, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });

    this._setUp(this.up);
    this._initEnvMap();

    const loop = () => {
      if (this.parentNode) {
        this.updateSize();
        if (this._dirty || this.autoRedraw) {
          if (!this.noAutoRecenter) this._updateEnvironment();
          renderer.render(scene, camera);
          this._dirty = false;
        }
        controls.update();
      }
      this._raf = requestAnimationFrame(loop);
    };
    loop();
  }

  connectedCallback() {
    if (!this.constructor._styletag) {
      const s = document.createElement('style');
      s.innerHTML = `
        ${this.tagName} { display: block; }
        ${this.tagName} canvas { width: 100%; height: 100%; }
      `;
      document.head.appendChild(s);
      this.constructor._styletag = s;
    }
    if (this.childElementCount === 0) this.appendChild(this.renderer.domElement);
    this.updateSize();
    requestAnimationFrame(() => this.updateSize());
  }

  disconnectedCallback() { cancelAnimationFrame(this._raf); }

  attributeChangedCallback(attr) {
    this._updateCollisionVisibility();
    if (!this.noAutoRecenter) this.recenter();

    if (attr === 'package' || attr === 'urdf') this._scheduleLoad();
    if (attr === 'up') this._setUp(this.up);
    if (attr === 'ambient-color') {
      this.ambientLight.color.set(this.ambientColor);
      this.ambientLight.groundColor.set('#000').lerp(this.ambientLight.color, 0.5);
    }
    if (attr === 'ignore-limits') this._setIgnoreLimits(this.ignoreLimits, true);
  }

  // public api
  updateSize() {
    const r = this.renderer, w = this.clientWidth, h = this.clientHeight;
    const { width, height } = r.getSize(new THREE.Vector2());
    if (width !== w || height !== h) this.recenter();

    r.setPixelRatio(window.devicePixelRatio);
    r.setSize(w, h, false);
    this.camera.aspect = w / h || 1;
    this.camera.updateProjectionMatrix();
  }

  redraw() { this._setNeedsRender(); }
  recenter() { this._updateEnvironment(); this.redraw(); }

  setJointValue(jointName, ...values) {
    if (!this.robot) return;
    const j = this.robot.joints[jointName];
    if (!j) return;
    if (j.setJointValue(...values)) {
      this.redraw();
      this.dispatchEvent(ev('angle-change', jointName));
    }
  }

  setJointValues(values) { for (const k in values) this.setJointValue(k, values[k]); }

  // env map
  _initEnvMap() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const applyEnv = (tex) => {
      const envMap = pmrem.fromEquirectangular(tex).texture;
      this.envMap = envMap;
      this.scene.environment = envMap;
      pmrem.dispose();
      this._applyEnvToSceneMaterials();
    };

    new RGBELoader().load(
      'https://threejs.org/examples/textures/equirectangular/quarry_01_1k.hdr',
      t => applyEnv(t),
      undefined,
      () => { // fallback to simple gradient
        const c = document.createElement('canvas'); c.width = 512; c.height = 256;
        const g = c.getContext('2d');
        const grd = g.createLinearGradient(0, 0, 0, c.height);
        grd.addColorStop(0, '#87CEEB'); grd.addColorStop(0.5, '#E0E0E0'); grd.addColorStop(1, '#808080');
        g.fillStyle = grd; g.fillRect(0, 0, c.width, c.height);
        const tex = new THREE.CanvasTexture(c);
        tex.mapping = THREE.EquirectangularReflectionMapping; tex.needsUpdate = true;
        applyEnv(tex);
      }
    );
  }

  _applyEnvToSceneMaterials() {
    if (!this.scene.environment) return;
    this._forEachMesh(this.scene, (mesh) => {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach(m => {
        if (!m) return;
        if (m.type === 'MeshStandardMaterial') {
          if (!m.envMap) m.envMap = this.scene.environment;
          if (m.roughness === undefined) m.roughness = 0.3;
          if (m.metalness === undefined) m.metalness = 0.2;
          m.envMapIntensity = 0.5;
          if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
          m.needsUpdate = true;
        }
      });
    });
    if (this._collisionMaterial && !this._collisionMaterial.envMap) {
      this._collisionMaterial.envMap = this.scene.environment;
      this._collisionMaterial.envMapIntensity = 0.5;
      this._collisionMaterial.needsUpdate = true;
    }
  }

  // loading
  _scheduleLoad() {
    const key = `${this.package}|${this.urdf}`;
    if (this._prevload === key || this._loadScheduled) return;
    this._prevload = key;
    this._loadScheduled = true;

    if (this.robot) {
      this.robot.traverse(c => c.dispose && c.dispose());
      this.robot.parent.remove(this.robot);
      this.robot = null;
    }

    requestAnimationFrame(() => { this._loadUrdf(this.package, this.urdf); this._loadScheduled = false; });
  }

  _parsePackages(pkgStr) {
    if (!pkgStr.includes(':') || pkgStr.split(':')[1].startsWith('//')) return pkgStr;
    return pkgStr.split(',').reduce((m, entry) => {
      const parts = entry.split(/:/).filter(Boolean);
      const name = parts.shift().trim();
      m[name] = parts.join(':').trim();
      return m;
    }, {});
  }

  _loadUrdf(pkg, urdf) {
    this.dispatchEvent(ev('urdf-change'));
    if (!urdf) return;

    const requestId = ++this._requestId;
    const manager = new THREE.LoadingManager();

    if (this.urlModifierFunc) manager.setURLModifier(this.urlModifierFunc);
    manager.onLoad = () => {
      if (this._requestId !== requestId) { robot?.traverse(c => c.dispose && c.dispose()); return; }
      this.robot = robot;
      this.world.add(robot);
      this._upgradeMaterials(robot);
      this._setIgnoreLimits(this.ignoreLimits);
      this._updateCollisionVisibility();
      this.dispatchEvent(ev('urdf-processed'));
      this.dispatchEvent(ev('geometry-loaded'));
      this.recenter();
    };

    const loader = new URDFLoader(manager);
    loader.packages = this._parsePackages(pkg);
    loader.loadMeshCb = this.loadMeshFunc;
    loader.fetchOptions = { mode: 'cors', credentials: 'same-origin' };
    loader.parseCollision = true;

    let robot = null;
    loader.load(urdf, model => (robot = model));
  }

  // materials
  _forEachMesh(root, fn) { root.traverse(o => { if (o.isMesh && o.material) fn(o); }); }

  _toStandardMaterial(m) {
    if (!m) return m;
    if (m.type === 'MeshStandardMaterial') {
      if (this.scene.environment && !m.envMap) m.envMap = this.scene.environment;
      if (m.roughness === undefined) m.roughness = 0.3;
      if (m.metalness === undefined) m.metalness = 0.2;
      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
      m.envMapIntensity = 0.5;
      m.needsUpdate = true;
      return m;
    }
    // convert legacy materials
    const color = (m.color ? m.color.clone() : new THREE.Color(0xcccccc));
    const out = new MeshStandardMaterial({
      color,
      map: m.map || null,
      roughness: m.roughness !== undefined ? m.roughness : 0.3,
      metalness: m.metalness !== undefined ? m.metalness : 0.2,
      transparent: m.transparent,
      opacity: m.opacity,
      side: m.side,
    });
    if (this.scene.environment) { out.envMap = this.scene.environment; out.envMapIntensity = 0.5; }
    if (out.map) out.map.colorSpace = THREE.SRGBColorSpace;
    out.needsUpdate = true;
    m.dispose && m.dispose();
    return out;
  }

  _upgradeMaterials(root) {
    this._forEachMesh(root, mesh => {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const upgraded = mats.map(m => this._toStandardMaterial(m));
      mesh.material = upgraded.length === 1 ? upgraded[0] : upgraded;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
  }

  // env and camera
  _updateEnvironment() {
    if (!this.robot) return;
    this.world.updateMatrixWorld();

    const bbox = new THREE.Box3().makeEmpty();
    this.robot.traverse(c => { if (c.isURDFVisual) bbox.expandByObject(c); });

    const center = bbox.getCenter(new THREE.Vector3());
    this.controls.target.y = center.y;
    this.plane.position.y = bbox.min.y - 1e-3;
    if (this.gridHelper) this.gridHelper.position.y = bbox.min.y - 0.999e-3;

    const dl = this.directionalLight;
    dl.castShadow = this.displayShadow;
    if (this.displayShadow) {
      const sphere = bbox.getBoundingSphere(new THREE.Sphere());
      const r = sphere.radius;
      const cam = dl.shadow.camera;
      cam.left = cam.bottom = -r; cam.right = cam.top = r;
      const offset = dl.position.clone().sub(dl.target.position);
      dl.target.position.copy(center);
      dl.position.copy(center).add(offset);
      cam.updateProjectionMatrix();
    }
  }

  _updateCollisionVisibility() {
    if (!this.robot) return;
    const show = this.showCollision;
    this._forEachMesh(this.robot, mesh => {
      if (mesh.parent?.isURDFCollider) {
        mesh.parent.visible = show;
        Object.assign(mesh, { raycast: emptyRaycast, castShadow: false });
        mesh.material = this._collisionMaterial;
      }
    });
    // ensure collider nodes toggle too
    this.robot.traverse(n => { if (n.isURDFCollider) n.visible = show; });
    this._applyEnvToSceneMaterials();
  }

  _setUp(up) {
    const U = (up || '+Z').toUpperCase();
    const sign = U.includes('-') ? '-' : '+';
    const axis = /[XYZ]/.exec(U)?.[0] || 'Z';
    const PI = Math.PI, H = PI / 2;
    if (axis === 'X') this.world.rotation.set(0, 0, sign === '+' ? H : -H);
    if (axis === 'Z') this.world.rotation.set(sign === '+' ? -H : H, 0, 0);
    if (axis === 'Y') this.world.rotation.set(sign === '+' ? 0 : PI, 0, 0);
  }

  _setIgnoreLimits(ignore, dispatch = false) {
    if (this.robot) {
      Object.values(this.robot.joints).forEach(j => { j.ignoreLimits = ignore; j.setJointValue(...j.jointValue); });
    }
    if (dispatch) this.dispatchEvent(ev('ignore-limits-change'));
  }
}
