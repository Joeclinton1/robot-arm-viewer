import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _m0 = new THREE.Matrix4();
const _m1 = new THREE.Matrix4();

function loadObjWithOptionalMtl(path, manager) {
    return new Promise(resolve => {
        const basePath = THREE.LoaderUtils.extractUrlBase(path);
        const objFile = path.substring(basePath.length);
        const mtlFile = objFile.replace(/\.obj$/i, '.mtl');

        const loadObj = materials => {
            const loader = new OBJLoader(manager);
            loader.setPath(basePath);
            if (materials) loader.setMaterials(materials);
            loader.load(
                objFile,
                object => resolve(object),
                null,
                () => resolve(null),
            );
        };

        const mtlLoader = new MTLLoader(manager);
        mtlLoader.setPath(basePath);
        mtlLoader.load(
            mtlFile,
            materials => {
                materials.preload();
                loadObj(materials);
            },
            null,
            () => loadObj(null),
        );
    });
}

function fusionMatrixToThree(matrixCm) {
    const m = matrixCm || [];
    return new THREE.Matrix4().set(
        m[0] || 1, m[1] || 0, m[2] || 0, (m[3] || 0) / 100,
        m[4] || 0, m[5] || 1, m[6] || 0, (m[7] || 0) / 100,
        m[8] || 0, m[9] || 0, m[10] || 1, (m[11] || 0) / 100,
        0, 0, 0, 1,
    );
}

function sampleMatrices(samples) {
    return (samples || [])
        .filter(sample => Array.isArray(sample.matrix_cm))
        .map(sample => ({
            angle: sample.angle,
            matrix: fusionMatrixToThree(sample.matrix_cm),
        }))
        .sort((a, b) => a.angle - b.angle);
}

function applyMatrix(object, matrix) {
    matrix.decompose(_pos, _quat, _scale);
    object.position.copy(_pos);
    object.quaternion.copy(_quat);
    object.scale.copy(_scale).multiplyScalar(0.001);
}

function interpolateSample(object, samples, angle) {
    if (!samples.length) return;

    if (angle <= samples[0].angle) {
        applyMatrix(object, samples[0].matrix);
        return;
    }

    const last = samples[samples.length - 1];
    if (angle >= last.angle) {
        applyMatrix(object, last.matrix);
        return;
    }

    for (let i = 0; i < samples.length - 1; i++) {
        const a = samples[i];
        const b = samples[i + 1];
        if (angle < a.angle || angle > b.angle) continue;

        const t = (angle - a.angle) / (b.angle - a.angle || 1);
        _m0.copy(a.matrix).decompose(_pos, _quat, _scale);
        const p0 = _pos.clone();
        const q0 = _quat.clone();
        const s0 = _scale.clone();

        _m1.copy(b.matrix).decompose(_pos, _quat, _scale);
        p0.lerp(_pos, t);
        q0.slerp(_quat, t);
        s0.lerp(_scale, t);

        object.position.copy(p0);
        object.quaternion.copy(q0);
        object.scale.copy(s0).multiplyScalar(0.001);
        return;
    }
}

export default class PincOpenSidecar {
    constructor(viewer) {
        this.viewer = viewer;
        this.group = null;
        this.driverJoint = null;
        this.driverJointName = null;
        this.angle = 0;
        this.angleLimits = { lower: -0.9, upper: 0.9 };
        this.parts = [];
        this.manifestUrl = null;
    }

    dispose() {
        if (this.group?.parent) this.group.parent.remove(this.group);
        this.group = null;
        this.driverJoint = null;
        this.driverJointName = null;
        this.angle = 0;
        this.angleLimits = { lower: -0.9, upper: 0.9 };
        this.parts = [];
        this.manifestUrl = null;
    }

    async loadForCurrentUrdf() {
        this.dispose();
        const urdf = this.viewer.urdf;
        const robot = this.viewer.robot;
        if (!urdf || !robot) return false;

        const base = THREE.LoaderUtils.extractUrlBase(urdf);
        const manifestUrl = `${base}pincopen/manifest.json`;
        let manifest = null;

        try {
            const response = await fetch(manifestUrl, { credentials: 'same-origin' });
            if (!response.ok) return false;
            manifest = await response.json();
        } catch {
            return false;
        }

        if (!manifest || manifest.type !== 'pincopen_sidecar') return false;
        if (this.viewer.urdf !== urdf || this.viewer.robot !== robot) return false;

        this.manifestUrl = manifestUrl;
        this.driverJointName = manifest.driver_joint;
        this.driverJoint = robot.joints?.[this.driverJointName] || null;
        this.angleLimits = {
            lower: manifest.angle_min ?? this.angleLimits.lower,
            upper: manifest.angle_max ?? this.angleLimits.upper,
        };
        this.group = new THREE.Group();
        this.group.name = 'pincopen_sidecar';

        this._hideCollapsedLinks(robot, manifest.hide_robot_links || []);

        const manager = new THREE.LoadingManager();
        const sidecarBase = THREE.LoaderUtils.extractUrlBase(manifestUrl);
        for (const part of manifest.parts || []) {
            const object = await loadObjWithOptionalMtl(sidecarBase + part.mesh, manager);
            if (!object) continue;

            object.name = `pincopen_${part.name}`;
            object.traverse(child => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });

            const samples = sampleMatrices(part.samples);
            this.group.add(object);
            this.parts.push({ object, samples });
        }

        if (this.viewer.urdf !== urdf || this.viewer.robot !== robot) {
            this.dispose();
            return false;
        }

        robot.add(this.group);
        this.setAngle(this.driverJoint?.angle || 0);
        this.viewer.dispatchEvent(new CustomEvent('pincopen-sidecar-loaded', {
            bubbles: true,
            cancelable: true,
            composed: true,
            detail: {
                jointName: this.driverJointName,
                limits: this.angleLimits,
                hasRobotJoint: !!this.driverJoint,
            },
        }));
        this.viewer.redraw();
        return true;
    }

    _hideCollapsedLinks(robot, linkNames) {
        for (const name of linkNames) {
            const link = robot.links?.[name];
            if (link) link.visible = false;
        }
    }

    updateForJoint(jointName, angle) {
        if (jointName !== this.driverJointName) return;
        this.setAngle(angle);
    }

    setAngle(angle) {
        const value = Number(angle);
        this.angle = Number.isFinite(value) ? value : 0;
        for (const part of this.parts) {
            interpolateSample(part.object, part.samples, this.angle);
        }
        this.viewer.redraw();
    }
}
