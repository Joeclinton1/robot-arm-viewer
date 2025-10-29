import * as THREE from 'three';
import { MeshPhongMaterial, MeshStandardMaterial } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import URDFLoader from './URDFLoader.js';

const tempVec2 = new THREE.Vector2();
const emptyRaycast = () => {};

// urdf-viewer element
// Loads and displays a 3D view of a URDF-formatted robot

// Events
// urdf-change: Fires when the URDF has finished loading and getting processed
// urdf-processed: Fires when the URDF has finished loading and getting processed
// geometry-loaded: Fires when all the geometry has been fully loaded
// ignore-limits-change: Fires when the 'ignore-limits' attribute changes
// angle-change: Fires when an angle changes
export default
class URDFViewer extends HTMLElement {

    static get observedAttributes() {

        return ['package', 'urdf', 'up', 'display-shadow', 'ambient-color', 'ignore-limits', 'show-collision'];

    }

    get package() { return this.getAttribute('package') || ''; }
    set package(val) { this.setAttribute('package', val); }

    get urdf() { return this.getAttribute('urdf') || ''; }
    set urdf(val) { this.setAttribute('urdf', val); }

    get ignoreLimits() { return this.hasAttribute('ignore-limits') || false; }
    set ignoreLimits(val) { val ? this.setAttribute('ignore-limits', val) : this.removeAttribute('ignore-limits'); }

    get up() { return this.getAttribute('up') || '+Z'; }
    set up(val) { this.setAttribute('up', val); }

    get displayShadow() { return this.hasAttribute('display-shadow') || false; }
    set displayShadow(val) { val ? this.setAttribute('display-shadow', '') : this.removeAttribute('display-shadow'); }

    get ambientColor() { return this.getAttribute('ambient-color') || '#8ea0a8'; }
    set ambientColor(val) { val ? this.setAttribute('ambient-color', val) : this.removeAttribute('ambient-color'); }

    get autoRedraw() { return this.hasAttribute('auto-redraw') || false; }
    set autoRedraw(val) { val ? this.setAttribute('auto-redraw', true) : this.removeAttribute('auto-redraw'); }

    get noAutoRecenter() { return this.hasAttribute('no-auto-recenter') || false; }
    set noAutoRecenter(val) { val ? this.setAttribute('no-auto-recenter', true) : this.removeAttribute('no-auto-recenter'); }

    get showCollision() { return this.hasAttribute('show-collision') || false; }
    set showCollision(val) { val ? this.setAttribute('show-collision', true) : this.removeAttribute('show-collision'); }

    get jointValues() {

        const values = {};
        if (this.robot) {

            for (const name in this.robot.joints) {

                const joint = this.robot.joints[name];
                values[name] = joint.jointValue.length === 1 ? joint.angle : [...joint.jointValue];

            }

        }

        return values;

    }
    set jointValues(val) { this.setJointValues(val); }

    get angles() {

        return this.jointValues;

    }
    set angles(v) {

        this.jointValues = v;

    }

    /* Lifecycle Functions */
    constructor() {

        super();

        this._requestId = 0;
        this._dirty = false;
        this._loadScheduled = false;
        this.robot = null;
        this.loadMeshFunc = null;
        this.urlModifierFunc = null;

        // Scene setup
        const scene = new THREE.Scene();

        const ambientLight = new THREE.HemisphereLight(this.ambientColor, '#000');
        ambientLight.groundColor.lerp(ambientLight.color, 0.5 * Math.PI);
        ambientLight.intensity = 0.5;
        ambientLight.position.set(0, 1, 0);
        scene.add(ambientLight);

        // Light setup
        const dirLight = new THREE.DirectionalLight(0xffffff, Math.PI);
        dirLight.position.set(4, 10, 1);
        dirLight.shadow.mapSize.width = 2048;
        dirLight.shadow.mapSize.height = 2048;
        dirLight.shadow.normalBias = 0.001;
        dirLight.castShadow = true;
        scene.add(dirLight);
        scene.add(dirLight.target);

        // Renderer setup
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setClearColor(0x263238); // Dark gray background (same as drag-and-drop mode)
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.outputColorSpace = THREE.SRGBColorSpace;

        // Camera setup
        const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
        camera.position.z = -10;

        // World setup
        const world = new THREE.Object3D();
        scene.add(world);

        const plane = new THREE.Mesh(
            new THREE.PlaneGeometry(40, 40),
            new THREE.ShadowMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.25 }),
        );
        plane.rotation.x = -Math.PI / 2;
        plane.position.y = -0.5;
        plane.receiveShadow = true;
        plane.scale.set(10, 10, 10);
        plane.raycast = emptyRaycast; // Don't block raycasts to robot
        scene.add(plane);

        // Add grid helper for floor reference
        const gridHelper = new THREE.GridHelper(5,100, 0x555555, 0x444444); // 200 divisions = 2 unit squares
        gridHelper.position.y = -0.499; // Slightly above plane to avoid z-fighting
        gridHelper.material.opacity = 0.5;
        gridHelper.material.transparent = true;
        gridHelper.raycast = emptyRaycast; // Don't block raycasts to robot
        scene.add(gridHelper);

        // Controls setup
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.rotateSpeed = 2.0;
        controls.zoomSpeed = 5;
        controls.panSpeed = 2;
        controls.enableZoom = true;
        controls.enableDamping = false;
        controls.maxDistance = 50;
        controls.minDistance = 0.25;
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

        // Environment map for reflections
        this.envMap = null;
        this._loadEnvironmentMap();

        this._setUp(this.up);

        this._collisionMaterial = new MeshStandardMaterial({
            transparent: true,
            opacity: 0.35,
            roughness: 0.3,
            metalness: 0.2,
            premultipliedAlpha: true,
            color: 0xffbe38,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
        });

        const _renderLoop = () => {

            if (this.parentNode) {

                this.updateSize();

                if (this._dirty || this.autoRedraw) {

                    if (!this.noAutoRecenter) {

                        this._updateEnvironment();
                    }

                    this.renderer.render(scene, camera);
                    this._dirty = false;

                }

                // update controls after the environment in
                // case the controls are retargeted
                this.controls.update();

            }
            this._renderLoopId = requestAnimationFrame(_renderLoop);

        };
        _renderLoop();

    }

    connectedCallback() {

        // Add our initialize styles for the element if they haven't
        // been added yet
        if (!this.constructor._styletag) {

            const styletag = document.createElement('style');
            styletag.innerHTML =
            `
                ${ this.tagName } { display: block; }
                ${ this.tagName } canvas {
                    width: 100%;
                    height: 100%;
                }
            `;
            document.head.appendChild(styletag);
            this.constructor._styletag = styletag;

        }

        // add the renderer
        if (this.childElementCount === 0) {

            this.appendChild(this.renderer.domElement);

        }

        this.updateSize();
        requestAnimationFrame(() => this.updateSize());

    }

    disconnectedCallback() {

        cancelAnimationFrame(this._renderLoopId);

    }

    attributeChangedCallback(attr, oldval, newval) {

        this._updateCollisionVisibility();
        if (!this.noAutoRecenter) {
            this.recenter();
        }

        switch (attr) {

            case 'package':
            case 'urdf': {

                this._scheduleLoad();
                break;

            }

            case 'up': {

                this._setUp(this.up);
                break;

            }

            case 'ambient-color': {

                this.ambientLight.color.set(this.ambientColor);
                this.ambientLight.groundColor.set('#000').lerp(this.ambientLight.color, 0.5);
                break;

            }

            case 'ignore-limits': {

                this._setIgnoreLimits(this.ignoreLimits, true);
                break;

            }

        }

    }

    /* Public API */
    _loadEnvironmentMap() {
        const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
        pmremGenerator.compileEquirectangularShader();

        // Try to load a real HDR environment map from Three.js examples
        // Available options from Three.js CDN:
        // - royal_esplanade_1k.hdr (outdoor, bright)
        // - venice_sunset_1k.hdr (warm sunset)
        // - quarry_01_1k.hdr (outdoor quarry)
        // - kiara_1_dawn_1k.hdr (dawn lighting)
        const hdrUrl = 'https://threejs.org/examples/textures/equirectangular/quarry_01_1k.hdr';

        const rgbeLoader = new RGBELoader();
        rgbeLoader.load(
            hdrUrl,
            (texture) => {
                const envMap = pmremGenerator.fromEquirectangular(texture).texture;
                this.envMap = envMap;
                this.scene.environment = envMap;

                texture.dispose();
                pmremGenerator.dispose();

                console.log('HDR environment map loaded:', hdrUrl);
            },
            undefined,
            (error) => {
                console.warn('Failed to load HDR environment map, using fallback', error);
                // Fallback to procedural environment
                this._createProceduralEnvironment(pmremGenerator);
            }
        );
    }

    _createProceduralEnvironment(pmremGenerator) {
        // Fallback: Create a simple gradient texture for environment
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');

        // Create gradient from light gray (top) to darker gray (bottom)
        const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
        gradient.addColorStop(0, '#87CEEB'); // Sky blue
        gradient.addColorStop(0.5, '#E0E0E0'); // Light gray
        gradient.addColorStop(1, '#808080'); // Medium gray
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const texture = new THREE.CanvasTexture(canvas);
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.needsUpdate = true;

        // Generate PMREM from texture
        const envMap = pmremGenerator.fromEquirectangular(texture).texture;
        this.envMap = envMap;
        this.scene.environment = envMap;

        // Clean up
        texture.dispose();
        pmremGenerator.dispose();

        console.log('Procedural environment map created');
    }

    updateSize() {

        const r = this.renderer;
        const w = this.clientWidth;
        const h = this.clientHeight;
        const currSize = r.getSize(tempVec2);

        if (currSize.width !== w || currSize.height !== h) {

            this.recenter();

        }

        r.setPixelRatio(window.devicePixelRatio);
        r.setSize(w, h, false);

        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();

    }

    redraw() {

        this._dirty = true;
    }

    recenter() {

        this._updateEnvironment();
        this.redraw();

    }

    // Set the joint with jointName to
    // angle in degrees
    setJointValue(jointName, ...values) {

        if (!this.robot) return;
        if (!this.robot.joints[jointName]) return;

        if (this.robot.joints[jointName].setJointValue(...values)) {

            this.redraw();
            this.dispatchEvent(new CustomEvent('angle-change', { bubbles: true, cancelable: true, detail: jointName }));

        }

    }

    setJointValues(values) {

        for (const name in values) this.setJointValue(name, values[name]);

    }

    /* Private Functions */
    // Updates the position of the plane to be at the
    // lowest point below the robot and focuses the
    // camera on the center of the scene
    _updateEnvironment() {

        const robot = this.robot;
        if (!robot) return;

        this.world.updateMatrixWorld();

        const bbox = new THREE.Box3();
        bbox.makeEmpty();
        robot.traverse(c => {
            if (c.isURDFVisual) {
                bbox.expandByObject(c);
            }
        });

        const center = bbox.getCenter(new THREE.Vector3());
        this.controls.target.y = center.y;
        this.plane.position.y = bbox.min.y - 1e-3;

        // Update grid position to match plane
        if (this.gridHelper) {
            this.gridHelper.position.y = bbox.min.y - 0.999e-3; // Slightly above plane
        }

        const dirLight = this.directionalLight;
        dirLight.castShadow = this.displayShadow;

        if (this.displayShadow) {

            // Update the shadow camera rendering bounds to encapsulate the
            // model. We use the bounding sphere of the bounding box for
            // simplicity -- this could be a tighter fit.
            const sphere = bbox.getBoundingSphere(new THREE.Sphere());
            const minmax = sphere.radius;
            const cam = dirLight.shadow.camera;
            cam.left = cam.bottom = -minmax;
            cam.right = cam.top = minmax;

            // Update the camera to focus on the center of the model so the
            // shadow can encapsulate it
            const offset = dirLight.position.clone().sub(dirLight.target.position);
            dirLight.target.position.copy(center);
            dirLight.position.copy(center).add(offset);

            cam.updateProjectionMatrix();

        }

    }

    _scheduleLoad() {

        // if our current model is already what's being requested
        // or has been loaded then early out
        if (this._prevload === `${ this.package }|${ this.urdf }`) return;
        this._prevload = `${ this.package }|${ this.urdf }`;

        // if we're already waiting on a load then early out
        if (this._loadScheduled) return;
        this._loadScheduled = true;

        if (this.robot) {

            this.robot.traverse(c => c.dispose && c.dispose());
            this.robot.parent.remove(this.robot);
            this.robot = null;

        }

        requestAnimationFrame(() => {

            this._loadUrdf(this.package, this.urdf);
            this._loadScheduled = false;

        });

    }

    // Watch the package and urdf field and load the robot model.
    // This should _only_ be called from _scheduleLoad because that
    // ensures the that current robot has been removed
    _loadUrdf(pkg, urdf) {

        this.dispatchEvent(new CustomEvent('urdf-change', { bubbles: true, cancelable: true, composed: true }));

        if (urdf) {

            // Keep track of this request and make
            // sure it doesn't get overwritten by
            // a subsequent one
            this._requestId++;
            const requestId = this._requestId;

            const updateMaterials = mesh => {

                mesh.traverse(c => {

                    if (c.isMesh) {

                        c.castShadow = true;
                        c.receiveShadow = true;

                        if (c.material) {

                            const mats =
                                (Array.isArray(c.material) ? c.material : [c.material])
                                    .map(m => {

                                        // Convert to PBR material for better reflections
                                        let newMat;

                                        if (m instanceof THREE.MeshBasicMaterial || m instanceof THREE.MeshPhongMaterial) {
                                            // Create new PBR material
                                            newMat = new THREE.MeshStandardMaterial({
                                                color: m.color ? m.color.clone() : new THREE.Color(0xcccccc),
                                                map: m.map,
                                                roughness: 0.3, // Default roughness for nice reflections
                                                metalness: 0.2, // Slight metallic look
                                                envMap: this.envMap,
                                                envMapIntensity: 1.0,
                                            });

                                            // Copy other properties if they exist
                                            if (m.transparent !== undefined) newMat.transparent = m.transparent;
                                            if (m.opacity !== undefined) newMat.opacity = m.opacity;
                                            if (m.side !== undefined) newMat.side = m.side;

                                            // Dispose old material
                                            if (m !== newMat) m.dispose();

                                            m = newMat;
                                        } else if (m instanceof THREE.MeshStandardMaterial) {
                                            // Already standard material, just add env map if not present
                                            if (!m.envMap && this.envMap) {
                                                m.envMap = this.envMap;
                                                m.envMapIntensity = 1.0;
                                            }
                                            // Set default roughness if not already set
                                            if (m.roughness === undefined || m.roughness === 1.0) {
                                                m.roughness = 0.2;
                                            }
                                            if (m.metalness === undefined) {
                                                m.metalness = 0.2;
                                            }
                                        }

                                        if (m.map) {
                                            m.map.colorSpace = THREE.SRGBColorSpace;
                                        }

                                        return m;

                                    });
                            c.material = mats.length === 1 ? mats[0] : mats;

                        }

                    }

                });

            };

            if (pkg.includes(':') && (pkg.split(':')[1].substring(0, 2)) !== '//') {
                // E.g. pkg = "pkg_name: path/to/pkg_name, pk2: path2/to/pk2"}

                // Convert pkg(s) into a map. E.g.
                // { "pkg_name": "path/to/pkg_name",
                //   "pk2":      "path2/to/pk2"      }

                pkg = pkg.split(',').reduce((map, value) => {

                    const split = value.split(/:/).filter(x => !!x);
                    const pkgName = split.shift().trim();
                    const pkgPath = split.join(':').trim();
                    map[pkgName] = pkgPath;

                    return map;

                }, {});
            }

            let robot = null;
            const manager = new THREE.LoadingManager();
            manager.onLoad = () => {

                // If another request has come in to load a new
                // robot, then ignore this one
                if (this._requestId !== requestId) {

                    robot.traverse(c => c.dispose && c.dispose());
                    return;

                }

                this.robot = robot;
                this.world.add(robot);
                updateMaterials(robot);

                this._setIgnoreLimits(this.ignoreLimits);
                this._updateCollisionVisibility();

                this.dispatchEvent(new CustomEvent('urdf-processed', { bubbles: true, cancelable: true, composed: true }));
                this.dispatchEvent(new CustomEvent('geometry-loaded', { bubbles: true, cancelable: true, composed: true }));

                this.recenter();

            };

            if (this.urlModifierFunc) {

                manager.setURLModifier(this.urlModifierFunc);

            }

            const loader = new URDFLoader(manager);
            loader.packages = pkg;
            loader.loadMeshCb = this.loadMeshFunc;
            loader.fetchOptions = { mode: 'cors', credentials: 'same-origin' };
            loader.parseCollision = true;
            loader.load(urdf, model => robot = model);

        }

    }

    _updateCollisionVisibility() {

        const showCollision = this.showCollision;
        const collisionMaterial = this._collisionMaterial;
        const robot = this.robot;

        if (robot === null) return;

        // Update collision material with environment map if available
        if (this.envMap && !collisionMaterial.envMap) {
            collisionMaterial.envMap = this.envMap;
            collisionMaterial.envMapIntensity = 0.5;
            collisionMaterial.needsUpdate = true;
        }

        const colliders = [];
        robot.traverse(c => {

            if (c.isURDFCollider) {

                c.visible = showCollision;
                colliders.push(c);

            }

        });

        colliders.forEach(coll => {

            coll.traverse(c => {

                if (c.isMesh) {

                    c.raycast = emptyRaycast;
                    c.material = collisionMaterial;
                    c.castShadow = false;

                }

            });

        });

    }

    // Watch the coordinate frame and update the
    // rotation of the scene to match
    _setUp(up) {

        if (!up) up = '+Z';
        up = up.toUpperCase();
        const sign = up.replace(/[^-+]/g, '')[0] || '+';
        const axis = up.replace(/[^XYZ]/gi, '')[0] || 'Z';

        const PI = Math.PI;
        const HALFPI = PI / 2;
        if (axis === 'X') this.world.rotation.set(0, 0, sign === '+' ? HALFPI : -HALFPI);
        if (axis === 'Z') this.world.rotation.set(sign === '+' ? -HALFPI : HALFPI, 0, 0);
        if (axis === 'Y') this.world.rotation.set(sign === '+' ? 0 : PI, 0, 0);

    }

    // Updates the current robot's angles to ignore
    // joint limits or not
    _setIgnoreLimits(ignore, dispatch = false) {

        if (this.robot) {

            Object
                .values(this.robot.joints)
                .forEach(joint => {

                    joint.ignoreLimits = ignore;
                    joint.setJointValue(...joint.jointValue);

                });

        }

        if (dispatch) {

            this.dispatchEvent(new CustomEvent('ignore-limits-change', { bubbles: true, cancelable: true, composed: true }));

        }

    }

};
