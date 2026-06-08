import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _m0 = new THREE.Matrix4();
const _m1 = new THREE.Matrix4();

function loadMtl(path, manager) {
    return new Promise(resolve => {
        const basePath = THREE.LoaderUtils.extractUrlBase(path);
        const mtlFile = path.substring(basePath.length);
        const mtlLoader = new MTLLoader(manager);
        mtlLoader.setPath(basePath);
        mtlLoader.load(
            mtlFile,
            materials => {
                materials.preload();
                resolve(materials);
            },
            null,
            () => resolve(null),
        );
    });
}

function loadObjWithMaterials(path, manager, materials = null) {
    return new Promise(resolve => {
        const basePath = THREE.LoaderUtils.extractUrlBase(path);
        const objFile = path.substring(basePath.length);
        const loader = new OBJLoader(manager);
        loader.setPath(basePath);
        if (materials) loader.setMaterials(materials);
        loader.load(
            objFile,
            object => resolve(object),
            null,
            () => resolve(null),
        );
    });
}

async function loadObjWithOptionalMtl(path, manager, useMaterials = true) {
    if (!useMaterials) return loadObjWithMaterials(path, manager);

    const basePath = THREE.LoaderUtils.extractUrlBase(path);
    const objFile = path.substring(basePath.length);
    const materials = await loadMtl(basePath + objFile.replace(/\.obj$/i, '.mtl'), manager);
    return loadObjWithMaterials(path, manager, materials);
}

function loadObjWithSharedMtl(path, manager, materials) {
    return new Promise(resolve => {
        const basePath = THREE.LoaderUtils.extractUrlBase(path);
        const objFile = path.substring(basePath.length);
        const loader = new OBJLoader(manager);
        loader.setPath(basePath);
        if (materials) loader.setMaterials(materials);
        loader.load(
            objFile,
            object => resolve(object),
            null,
            () => resolve(null),
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

function keywordMatch(value, keywords) {
    const text = String(value || '').toLowerCase();
    return keywords.some(keyword => keyword && text.includes(String(keyword).toLowerCase()));
}

function normalizedReplaceRules(manifest) {
    if (manifest.replace) {
        return {
            linkKeywords: manifest.replace.link_keywords || [],
            visualKeywords: manifest.replace.visual_keywords || [],
            meshKeywords: manifest.replace.mesh_keywords || [],
        };
    }

    return {
        linkKeywords: manifest.hide_robot_links || [],
        visualKeywords: [],
        meshKeywords: ['pincopen'],
    };
}

function uniqueValues(values) {
    return [...new Set(values.filter(Boolean))];
}

function parentDirectory(path) {
    const trimmed = String(path || '').replace(/\/+$/g, '');
    const index = trimmed.lastIndexOf('/');
    return index === -1 ? '' : trimmed.substring(0, index + 1);
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

function wrapAngle(angle, lower, upper) {
    const span = upper - lower;
    if (!Number.isFinite(span) || span <= 0) return angle;
    return ((((angle - lower) % span) + span) % span) + lower;
}

export default class PincOpenSidecar {
    constructor(viewer) {
        this.viewer = viewer;
        this.group = null;
        this.driverJoint = null;
        this.driverJointName = null;
        this.angle = 0;
        this.angleOffset = 0;
        this.angleLimits = { lower: 0, upper: Math.PI * 2 };
        this.parts = [];
        this.manifestUrl = null;
        this.syntheticJoint = null;
        this.anchor = null;
    }

    dispose() {
        if (this.group?.parent) this.group.parent.remove(this.group);
        this.group = null;
        this.driverJoint = null;
        this.driverJointName = null;
        this.angle = 0;
        this.angleOffset = 0;
        this.angleLimits = { lower: 0, upper: Math.PI * 2 };
        this.parts = [];
        this.manifestUrl = null;
        if (this.syntheticJoint && this.viewer.robot?.joints?.[this.syntheticJoint.name] === this.syntheticJoint) {
            delete this.viewer.robot.joints[this.syntheticJoint.name];
        }
        if (this.syntheticJoint?.parent) this.syntheticJoint.parent.remove(this.syntheticJoint);
        this.syntheticJoint = null;
        if (this.anchor?.parent) this.anchor.parent.remove(this.anchor);
        this.anchor = null;
    }

    async loadForCurrentUrdf() {
        this.dispose();
        const urdf = this.viewer.urdf;
        const robot = this.viewer.robot;
        if (!urdf || !robot) return false;

        const manifestUrl = await this._loadManifestUrl(urdf);
        let manifest = null;
        if (!manifestUrl) return false;

        try {
            const response = await fetch(this._resolveUrl(manifestUrl), { credentials: 'same-origin' });
            if (!response.ok) return false;
            manifest = await response.json();
        } catch {
            return false;
        }

        if (!manifest || manifest.type !== 'pincopen_sidecar') return false;
        if (this.viewer.urdf !== urdf || this.viewer.robot !== robot) return false;

        this.manifestUrl = manifestUrl;
        this.driverJointName = manifest.driver_joint;
        const realDriverJoint = robot.joints?.[this.driverJointName] || null;
        this.driverJoint = realDriverJoint;
        this.angleLimits = {
            lower: manifest.angle_min ?? this.angleLimits.lower,
            upper: manifest.angle_max ?? this.angleLimits.upper,
        };
        this.angleOffset =
            Number(manifest.angle_offset_radians || 0) +
            Number(manifest.angle_offset_degrees || 0) * Math.PI / 180;
        this.group = new THREE.Group();
        this.group.name = 'pincopen_sidecar';
        this.group.isURDFVisual = true;

        const manager = new THREE.LoadingManager();
        if (this.viewer.urlModifierFunc) manager.setURLModifier(this.viewer.urlModifierFunc);
        const sidecarBase = THREE.LoaderUtils.extractUrlBase(manifestUrl);
        const useSharedMaterials = this.viewer.fastPincOpenSidecar;
        const materialLibraryUrl = sidecarBase + (manifest.material_library || 'materials.combined.mtl');
        const sharedMaterials = useSharedMaterials ? await loadMtl(materialLibraryUrl, manager) : null;
        const loadedParts = await this._loadParts(
            manifest.parts || [],
            sidecarBase,
            manager,
            useSharedMaterials,
            sharedMaterials,
        );

        for (const loaded of loadedParts) {
            if (!loaded) continue;
            this.group.add(loaded.object);
            this.parts.push(loaded);
        }
        if (this.parts.length === 0) {
            this.dispose();
            return false;
        }

        if (this.viewer.urdf !== urdf || this.viewer.robot !== robot) {
            this.dispose();
            return false;
        }

        const replacedVisual = this._hideReplacedGeometry(robot, normalizedReplaceRules(manifest));
        const attachLink = robot.links?.[manifest.attach_link || 'gripper'] || robot;
        const attachParent = this._createAnchorFromReplacedVisual(replacedVisual) || attachLink;
        if (!this.driverJoint) {
            this.driverJoint = this._createSyntheticJoint(this.driverJointName, attachParent);
            robot.joints[this.driverJointName] = this.driverJoint;
        }
        this.driverJoint.add(this.group);
        this.setAngle(this.driverJoint?.angle || 0);
        this.viewer.dispatchEvent(new CustomEvent('pincopen-sidecar-loaded', {
            bubbles: true,
            cancelable: true,
            composed: true,
            detail: {
                jointName: this.driverJointName,
                limits: this.angleLimits,
                hasRobotJoint: !!realDriverJoint,
                partCount: this.parts.length,
                anchoredToReplacedVisual: !!replacedVisual,
            },
        }));
        console.info('PincOpen sidecar loaded', {
            manifestUrl: this.manifestUrl,
            driverJoint: this.driverJointName,
            attachLink: manifest.attach_link || 'gripper',
            partCount: this.parts.length,
            anchoredToReplacedVisual: !!replacedVisual,
        });
        this.viewer.redraw();
        return true;
    }

    async _loadParts(parts, sidecarBase, manager, useSharedMaterials, sharedMaterials) {
        return Promise.all(parts.map(async part => {
            const object = useSharedMaterials
                ? await loadObjWithSharedMtl(sidecarBase + part.mesh, manager, sharedMaterials)
                : await loadObjWithOptionalMtl(sidecarBase + part.mesh, manager, true);
            if (!object) return null;

            object.name = `pincopen_${part.name}`;
            object.traverse(child => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });

            return { object, samples: sampleMatrices(part.samples) };
        }));
    }

    _createSyntheticJoint(name, parent) {
        const joint = new THREE.Object3D();
        joint.name = name;
        joint.urdfName = name;
        joint.isURDFJoint = true;
        joint.jointType = 'revolute';
        joint.axis = new THREE.Vector3(0, 0, 1);
        joint.limit = { lower: this.angleLimits.lower, upper: this.angleLimits.upper };
        joint.jointValue = [this.angle];
        joint.mimicJoints = [];
        joint.ignoreLimits = true;
        joint.setJointValue = value => {
            const angle = Number(value);
            if (!Number.isFinite(angle) || angle === joint.jointValue[0]) return false;
            joint.jointValue[0] = angle;
            this.setAngle(angle);
            return true;
        };
        Object.defineProperty(joint, 'angle', {
            get: () => joint.jointValue[0],
        });
        parent.add(joint);
        this.syntheticJoint = joint;
        return joint;
    }

    _createAnchorFromReplacedVisual(visual) {
        if (!visual?.parent) return null;
        const anchor = new THREE.Object3D();
        anchor.name = 'pincopen_sidecar_anchor';
        anchor.position.copy(visual.position);
        anchor.quaternion.copy(visual.quaternion);
        visual.parent.add(anchor);
        this.anchor = anchor;
        return anchor;
    }

    async _loadManifestUrl(urdf) {
        const base = THREE.LoaderUtils.extractUrlBase(urdf);
        const parent = parentDirectory(base);
        const candidates = uniqueValues([
            `${parent}pincopen/manifest.json`,
            `${base}pincopen/manifest.json`,
        ]);

        for (const candidate of candidates) {
            try {
                const response = await fetch(this._resolveUrl(candidate), { credentials: 'same-origin' });
                if (response.ok) return candidate;
            } catch {
                // try the next candidate
            }
        }

        return null;
    }

    _resolveUrl(url) {
        return this.viewer.urlModifierFunc ? this.viewer.urlModifierFunc(url) : url;
    }

    _hideReplacedGeometry(robot, rules) {
        let firstMatch = null;
        robot.traverse(node => {
            if (!node.isURDFVisual && !node.isURDFCollider) return;

            const link = this._nearestLink(node);
            const matchesLink = keywordMatch(link?.urdfName || link?.name, rules.linkKeywords);
            const matchesVisual = keywordMatch(node.urdfName || node.name, rules.visualKeywords);
            const matchesMesh = keywordMatch(node.urdfMeshFilename, rules.meshKeywords) ||
                keywordMatch(node.urdfMeshPath, rules.meshKeywords);

            if (matchesLink || matchesVisual || matchesMesh) {
                if (!firstMatch && node.isURDFVisual) firstMatch = node;
                node.visible = false;
            }
        });
        return firstMatch;
    }

    _nearestLink(node) {
        let current = node.parent;
        while (current) {
            if (current.isURDFLink) return current;
            current = current.parent;
        }
        return null;
    }

    updateForJoint(jointName, angle) {
        if (jointName !== this.driverJointName) return;
        this.setAngle(angle);
    }

    setAngle(angle) {
        const value = Number(angle);
        this.angle = Number.isFinite(value) ? value : 0;
        if (this.syntheticJoint) this.syntheticJoint.jointValue[0] = this.angle;
        const sampleAngle = wrapAngle(this.angle + this.angleOffset, this.angleLimits.lower, this.angleLimits.upper);
        this.setSampleAngle(sampleAngle);
    }

    setSampleAngle(angle, updateDriver = false) {
        const sampleAngle = wrapAngle(angle, this.angleLimits.lower, this.angleLimits.upper);
        if (updateDriver) {
            this.angle = wrapAngle(sampleAngle - this.angleOffset, this.angleLimits.lower, this.angleLimits.upper);
            if (this.syntheticJoint) this.syntheticJoint.jointValue[0] = this.angle;
        }
        for (const part of this.parts) {
            interpolateSample(part.object, part.samples, sampleAngle);
        }
        this.viewer.redraw();
    }
}
