/* globals */
import * as THREE from 'three';
import { registerDragEvents } from './dragAndDrop.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import URDFManipulator from './urdf-manipulator-element.js';
import { OBJExporter } from './OBJExporter.js';
import { DAEExporter } from './DAEExporter.js';

customElements.define('urdf-viewer', URDFManipulator);

// declare these globally for the sake of the example.
// Hack to make the build work with webpack for now.
// TODO: Remove this once modules or parcel is being used
const viewer = document.querySelector('urdf-viewer');

const limitsToggle = document.getElementById('ignore-joint-limits');
const collisionToggle = document.getElementById('collision-toggle');
const radiansToggle = document.getElementById('radians-toggle');
const autocenterToggle = document.getElementById('autocenter-toggle');
const upSelect = document.getElementById('up-select');
const sliderList = document.querySelector('#controls ul');
const controlsel = document.getElementById('controls');
const controlsToggle = document.getElementById('toggle-controls');
const animToggle = document.getElementById('do-animate');
const ikModeToggle = document.getElementById('ik-mode');
const exportObjButton = document.getElementById('export-obj');
const showAxesToggle = document.getElementById('show-axes');
const showBananaToggle = document.getElementById('show-banana');
const interactionInstruction = document.getElementById('interaction-instruction');
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 1 / DEG2RAD;
let sliders = {};
let gripperControl = null;
let gripperTarget = null;
let gripperNextTarget = null;
let gripperLastTargetTime = 0;
const gripperTargetDuration = 900;
const gripperStepFraction = 0.28;

const jointLimit = joint => ({
    lower: Number.isFinite(joint?.limit?.lower) ? joint.limit.lower : -1,
    upper: Number.isFinite(joint?.limit?.upper) ? joint.limit.upper : 1,
});

const jointSpan = joint => {
    const limit = jointLimit(joint);
    return Math.max(0, limit.upper - limit.lower);
};

const getJointValue = joint => joint?.angle ?? joint?.jointValue?.[0] ?? 0;

const createSingleJointGripperControl = joint => {
    const limit = jointLimit(joint);
    return {
        name: joint.name,
        type: joint.jointType,
        limits: limit,
        getValue: () => getJointValue(joint),
        setValue: value => viewer.setJointValue(joint.name, value),
        containsJoint: candidate => candidate?.name === joint.name,
    };
};

const createPairedPrismaticGripperControl = joints => {
    const spans = joints.map(jointSpan).filter(span => span > 0);
    const maxOpen = spans.length ? Math.min(...spans) : 0.04;
    const openSign = joint => {
        const limit = jointLimit(joint);
        if (limit.upper <= 0 && limit.lower < 0) return -1;
        if (limit.lower >= 0 && limit.upper > 0) return 1;
        return Math.abs(limit.upper) >= Math.abs(limit.lower) ? 1 : -1;
    };
    const center = joint => {
        const limit = jointLimit(joint);
        if (limit.lower < 0 && limit.upper > 0) return 0;
        return Math.abs(limit.lower) < Math.abs(limit.upper) ? limit.lower : limit.upper;
    };

    return {
        name: 'gripper',
        type: 'prismatic',
        limits: { lower: 0, upper: maxOpen },
        joints,
        getValue: () => Math.max(0, ...joints.map(joint => Math.abs(getJointValue(joint) - center(joint)))),
        setValue: value => {
            const open = Math.max(0, Math.min(maxOpen, Number(value) || 0));
            joints.forEach(joint => viewer.setJointValue(joint.name, center(joint) + openSign(joint) * open));
        },
        containsJoint: candidate => joints.some(joint => joint.name === candidate?.name),
    };
};

const createPincOpenGripperControl = sidecar => ({
    name: sidecar.driverJointName || 'autorig_cam_to_motor_frame',
    type: 'revolute',
    limits: sidecar.angleLimits || { lower: 0, upper: Math.PI * 2 },
    getValue: () => sidecar.angle,
    setValue: value => sidecar.setAngle(value),
    containsJoint: joint => joint?.name === (sidecar.driverJointName || 'autorig_cam_to_motor_frame'),
});

const findDetectedGripperControl = () => {
    if (!viewer.robot?.joints) return null;

    const joints = Object.values(viewer.robot.joints).filter(joint => joint.isURDFJoint && joint.jointType !== 'fixed');
    const sorted = getAllSortedMovableJoints();
    const tail = sorted.slice(-2);
    if (tail.length === 2 && tail.every(joint => joint.jointType === 'prismatic')) {
        return createPairedPrismaticGripperControl(tail);
    }

    const named = joints.find(joint => /(^|[_-])gripper($|[_-]joint$)|^gripper$/i.test(joint.name || ''));
    if (named) return createSingleJointGripperControl(named);

    return null;
};

const setGripperControl = control => {
    gripperControl = control;
    gripperTarget = control ? control.getValue() : null;
    gripperNextTarget = gripperTarget;
    gripperLastTargetTime = performance.now();
};

function loadObjWithOptionalMtl(path, manager, done) {
    const basePath = THREE.LoaderUtils.extractUrlBase(path);
    const objFile = path.substring(basePath.length);
    const mtlFile = objFile.replace(/\.obj$/i, '.mtl');

    const loadObj = (materials = null) => {
        const loader = new OBJLoader(manager);
        loader.setPath(basePath);
        if (materials) loader.setMaterials(materials);
        loader.load(
            objFile,
            result => done(result),
            null,
            err => done(null, err),
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
        () => loadObj(),
    );
}

// Create axis helper
let axesHelper = null;

// Banana for scale
let banana = null;

const updateInteractionInstruction = () => {
    if (!interactionInstruction) return;
    interactionInstruction.textContent = viewer.ikMode
        ? 'Drag robot arm to pose with IK'
        : 'Drag robot arm joint to change angle';
};

const syncAutocenterToggle = () => {
    autocenterToggle.classList.toggle('checked', !viewer.noAutoRecenter);
};

// Global Functions
const setColor = color => {

    document.body.style.backgroundColor = color;
    viewer.highlightColor = '#' + (new THREE.Color(0xffffff)).lerp(new THREE.Color(color), 0.35).getHexString();

};

// Events
// toggle checkbox
limitsToggle.addEventListener('click', () => {
    limitsToggle.classList.toggle('checked');
    viewer.ignoreLimits = limitsToggle.classList.contains('checked');
});

radiansToggle.addEventListener('click', () => {
    radiansToggle.classList.toggle('checked');
    Object
        .values(sliders)
        .forEach(sl => sl.update());
});

collisionToggle.addEventListener('click', () => {
    collisionToggle.classList.toggle('checked');
    viewer.showCollision = collisionToggle.classList.contains('checked');
});

autocenterToggle.addEventListener('click', () => {
    autocenterToggle.classList.toggle('checked');
    viewer.noAutoRecenter = !autocenterToggle.classList.contains('checked');
});

ikModeToggle.addEventListener('click', () => {
    ikModeToggle.classList.toggle('checked');
    const isIKMode = ikModeToggle.classList.contains('checked');
    viewer.ikMode = isIKMode;
    updateInteractionInstruction();

    // Disable animation when in IK mode
    if (isIKMode) {
        animToggle.classList.remove('checked');
    }
});

showAxesToggle.addEventListener('click', () => {
    showAxesToggle.classList.toggle('checked');
    const showAxes = showAxesToggle.classList.contains('checked');

    if (showAxes && !axesHelper) {
        // Create axes helper: Red = X, Green = Y, Blue = Z
        axesHelper = new THREE.AxesHelper(0.5);
        viewer.scene.add(axesHelper);
        viewer.redraw();
    } else if (!showAxes && axesHelper) {
        viewer.scene.remove(axesHelper);
        axesHelper = null;
        viewer.redraw();
    }
});

showBananaToggle.addEventListener('click', () => {
    showBananaToggle.classList.toggle('checked');
    const showBanana = showBananaToggle.classList.contains('checked');

    if (showBanana) {
        if (!banana) {
            // Load banana GLB file
            const loader = new GLTFLoader();
            loader.load('./urdf/Banana.glb', (gltf) => {
                banana = gltf.scene;

                // Scale to average banana size (18cm = 0.18m)
                // Original model: X=3.25257m, Y=2.58608m
                // Diagonal = sqrt(3.25257^2 + 2.58608^2) ≈ 4.155m
                // Scale = 0.18 / 4.155 ≈ 0.0433
                banana.scale.set(0.0433, 0.0433, 0.0433);

                // Position banana next to robot base
                banana.position.set(0.3, 0, 0);

                viewer.scene.add(banana);
                viewer.redraw();
            });
        } else {
            viewer.scene.add(banana);
            viewer.redraw();
        }
    } else if (banana) {
        viewer.scene.remove(banana);
        viewer.redraw();
    }
});

upSelect.addEventListener('change', () => viewer.up = upSelect.value);

controlsToggle.addEventListener('click', () => controlsel.classList.toggle('hidden'));

// Export DAE functionality
exportObjButton.addEventListener('click', () => {
    if (!viewer.robot) {
        alert('No robot loaded to export!');
        return;
    }

    console.log('Exporting robot to DAE format...');

    // Generate filename based on URDF name or use default
    const urdfPath = viewer.urdf || 'robot';
    const filename = urdfPath.split('/').pop().replace('.urdf', '') + '.dae';

    const exporter = new DAEExporter();
    const daeContent = exporter.parse(viewer.robot);

    DAEExporter.download(daeContent, filename);
    console.log('Export complete!');
});

// watch for urdf changes
viewer.addEventListener('urdf-change', () => {

    Object
        .values(sliders)
        .forEach(sl => sl.remove());
    sliders = {};
    setGripperControl(null);

});

viewer.addEventListener('ignore-limits-change', () => {

    Object
        .values(sliders)
        .forEach(sl => sl.update());

});

viewer.addEventListener('angle-change', e => {

    if (sliders[e.detail]) sliders[e.detail].update();
    if (gripperControl?.joints?.some(joint => joint.name === e.detail)) {
        sliders[gripperControl.name]?.update();
    }

});

viewer.addEventListener('joint-mouseover', e => {

    const j = document.querySelector(`li[joint-name="${ e.detail }"]`);
    if (j) j.setAttribute('robot-hovered', true);

});

viewer.addEventListener('joint-mouseout', e => {

    const j = document.querySelector(`li[joint-name="${ e.detail }"]`);
    if (j) j.removeAttribute('robot-hovered');

});

let originalNoAutoRecenter;
viewer.addEventListener('manipulate-start', e => {

    const j = document.querySelector(`li[joint-name="${ e.detail }"]`);
    if (j) {
        j.scrollIntoView({ block: 'nearest' });
        window.scrollTo(0, 0);
    }

    originalNoAutoRecenter = viewer.noAutoRecenter;
    viewer.noAutoRecenter = true;

});

viewer.addEventListener('manipulate-end', e => {

    viewer.noAutoRecenter = originalNoAutoRecenter;

});

// create the sliders
viewer.addEventListener('urdf-processed', () => {

    const r = viewer.robot;
    updateLoadedRobotInfo();
    setGripperControl(findDetectedGripperControl());
    Object
        .keys(r.joints)
        .sort((a, b) => {

            const da = a.split(/[^\d]+/g).filter(v => !!v).pop();
            const db = b.split(/[^\d]+/g).filter(v => !!v).pop();

            if (da !== undefined && db !== undefined) {
                const delta = parseFloat(da) - parseFloat(db);
                if (delta !== 0) return delta;
            }

            if (a > b) return 1;
            if (b > a) return -1;
            return 0;

        })
        .map(key => r.joints[key])
        .forEach(joint => {
            if (gripperControl?.containsJoint(joint) && gripperControl.joints) return;

            const li = document.createElement('li');
            li.innerHTML =
            `
            <span title="${ joint.name }">${ joint.name }</span>
            <input type="range" value="0" step="0.0001"/>
            <input type="number" step="0.0001" />
            `;
            li.setAttribute('joint-type', joint.jointType);
            li.setAttribute('joint-name', joint.name);

            sliderList.appendChild(li);

            // update the joint display
            const slider = li.querySelector('input[type="range"]');
            const input = li.querySelector('input[type="number"]');
            li.update = () => {
                const degMultiplier = radiansToggle.classList.contains('checked') ? 1.0 : RAD2DEG;
                let angle = joint.angle;

                if (joint.jointType === 'revolute' || joint.jointType === 'continuous') {
                    angle *= degMultiplier;
                }

                if (Math.abs(angle) > 1) {
                    angle = angle.toFixed(1);
                } else {
                    angle = angle.toPrecision(2);
                }

                input.value = parseFloat(angle);

                // directly input the value
                slider.value = joint.angle;

                if (viewer.ignoreLimits || joint.jointType === 'continuous') {
                    slider.min = -6.28;
                    slider.max = 6.28;

                    input.min = -6.28 * degMultiplier;
                    input.max = 6.28 * degMultiplier;
                } else {
                    slider.min = joint.limit.lower;
                    slider.max = joint.limit.upper;

                    input.min = joint.limit.lower * degMultiplier;
                    input.max = joint.limit.upper * degMultiplier;
                }
            };

            switch (joint.jointType) {

                case 'continuous':
                case 'prismatic':
                case 'revolute':
                    break;
                default:
                    li.update = () => {};
                    input.remove();
                    slider.remove();

            }

            slider.addEventListener('input', () => {
                viewer.setJointValue(joint.name, slider.value);
                li.update();
            });

            input.addEventListener('change', () => {
                const valueMultiplier = joint.jointType === 'revolute' || joint.jointType === 'continuous'
                    ? (radiansToggle.classList.contains('checked') ? 1.0 : DEG2RAD)
                    : 1.0;
                viewer.setJointValue(joint.name, input.value * valueMultiplier);
                li.update();
            });

            li.update();

            sliders[joint.name] = li;

        });

    if (gripperControl?.joints) {
        const li = document.createElement('li');
        li.innerHTML =
        `
        <span title="${ gripperControl.joints.map(joint => joint.name).join(' + ') }">gripper</span>
        <input type="range" value="0" step="0.0001"/>
        <input type="number" step="0.0001" />
        `;
        li.setAttribute('joint-type', gripperControl.type);
        li.setAttribute('joint-name', gripperControl.name);
        sliderList.appendChild(li);

        const slider = li.querySelector('input[type="range"]');
        const input = li.querySelector('input[type="number"]');
        li.update = () => {
            const value = gripperControl.getValue();
            input.value = Math.abs(value) > 1 ? parseFloat(value.toFixed(1)) : parseFloat(value.toPrecision(2));
            slider.value = value;
            slider.min = gripperControl.limits.lower;
            slider.max = gripperControl.limits.upper;
            input.min = gripperControl.limits.lower;
            input.max = gripperControl.limits.upper;
        };

        slider.addEventListener('input', () => {
            gripperControl.setValue(slider.value);
            li.update();
        });

        input.addEventListener('change', () => {
            gripperControl.setValue(input.value);
            li.update();
        });

        li.update();
        sliders[gripperControl.name] = li;
    }

});

viewer.addEventListener('pincopen-sidecar-loaded', e => {
    const sidecar = viewer.pincOpenSidecar;
    const jointName = e.detail?.jointName || sidecar?.driverJointName || 'autorig_cam_to_motor_frame';
    if (!sidecar) return;
    setGripperControl(createPincOpenGripperControl(sidecar));
    if (e.detail?.hasRobotJoint || sliders[jointName]) return;

    const li = document.createElement('li');
    li.innerHTML =
    `
    <span title="${ jointName }">${ jointName }</span>
    <input type="range" value="0" step="0.0001"/>
    <input type="number" step="0.0001" />
    `;
    li.setAttribute('joint-type', 'revolute');
    li.setAttribute('joint-name', jointName);

    sliderList.appendChild(li);

    const slider = li.querySelector('input[type="range"]');
    const input = li.querySelector('input[type="number"]');
    const limits = e.detail?.limits || sidecar.angleLimits || { lower: -0.9, upper: 0.9 };

    li.update = () => {
        const degMultiplier = radiansToggle.classList.contains('checked') ? 1.0 : RAD2DEG;
        let angle = sidecar.angle * degMultiplier;
        angle = Math.abs(angle) > 1 ? angle.toFixed(1) : angle.toPrecision(2);

        input.value = parseFloat(angle);
        slider.value = sidecar.angle;
        slider.min = limits.lower;
        slider.max = limits.upper;
        input.min = limits.lower * degMultiplier;
        input.max = limits.upper * degMultiplier;
    };

    slider.addEventListener('input', () => {
        sidecar.setAngle(slider.value);
        li.update();
    });

    input.addEventListener('change', () => {
        const valueMultiplier = radiansToggle.classList.contains('checked') ? 1.0 : DEG2RAD;
        sidecar.setAngle(input.value * valueMultiplier);
        li.update();
    });

    li.update();
    sliders[jointName] = li;
});

document.addEventListener('WebComponentsReady', () => {

    viewer.loadMeshFunc = (path, manager, done) => {

        const ext = path.split(/\./g).pop().toLowerCase();
        switch (ext) {

            case 'gltf':
            case 'glb':
                new GLTFLoader(manager).load(
                    path,
                    result => done(result.scene),
                    null,
                    err => done(null, err),
                );
                break;
            case 'obj':
                loadObjWithOptionalMtl(path, manager, done);
                break;
            case 'dae':
                new ColladaLoader(manager).load(
                    path,
                    result => done(result.scene),
                    null,
                    err => done(null, err),
                );
                break;
            case 'stl':
                new STLLoader(manager).load(
                    path,
                    result => {
                        const material = new THREE.MeshPhongMaterial();
                        const mesh = new THREE.Mesh(result, material);
                        done(mesh);
                    },
                    null,
                    err => done(null, err),
                );
                break;

        }

    };

    // Robot will be loaded automatically by loadRobotManifest()

    if (/javascript\/example\/bundle/i.test(window.location)) {
        viewer.package = '../../../urdf';
    }

    registerDragEvents(viewer, dropInfo => {
        setColor('#263238');
        animToggle.classList.remove('checked');
        updateList();
        if (dropInfo?.selectedUrdf) {
            const name = dropInfo.selectedUrdf.split(/[\\\/]/).pop().replace(/\.urdf$/i, '');
            updateRobotInfo(name, {
                custom: true,
                name,
                path: dropInfo.selectedUrdf,
                specs: {
                    Source: dropInfo.selectedUrdf,
                },
            });
        }
    });

});

// Animation state for IK targeting
let currentTarget = new THREE.Vector3();
let nextTarget = new THREE.Vector3();
let smoothedTarget = new THREE.Vector3();
let transitionProgress = 1; // 0 to 1
let transitionDuration = 2000; // milliseconds
let lastTransitionTime = 0;
let activeAnimationUsesHumanoidWorkspace = false;

const randomGripperTarget = () => {
    if (!gripperControl) return null;
    const { lower, upper } = gripperControl.limits;
    const span = Math.max(0, upper - lower);
    if (span <= 0) return lower;

    const current = gripperControl.getValue();
    const maxStep = span * gripperStepFraction;
    const biased = Math.random() < 0.22
        ? (Math.random() < 0.5 ? lower : upper)
        : lower + Math.random() * span;
    const delta = Math.max(-maxStep, Math.min(maxStep, biased - current));
    return Math.max(lower, Math.min(upper, current + delta));
};

const updateAnimatedGripper = now => {
    if (!gripperControl || viewer.ikControls?.isDragging) return;

    if (gripperTarget === null || gripperNextTarget === null) {
        gripperTarget = gripperControl.getValue();
        gripperNextTarget = randomGripperTarget();
        gripperLastTargetTime = now;
    }

    if (now - gripperLastTargetTime >= gripperTargetDuration) {
        gripperTarget = gripperControl.getValue();
        gripperNextTarget = randomGripperTarget();
        gripperLastTargetTime = now;
    }

    const progress = Math.min(1, (now - gripperLastTargetTime) / gripperTargetDuration);
    const t = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    const value = gripperTarget + (gripperNextTarget - gripperTarget) * t;
    gripperControl.setValue(value);
    sliders[gripperControl.name]?.update();
};

const sortMovableJoints = joints => joints.sort((a, b) => {
    const aMatch = a.name.match(/(?:^|_to_)link(\d+)|base_link/);
    const bMatch = b.name.match(/(?:^|_to_)link(\d+)|base_link/);
    const aIndex = a.name.includes('base_link') ? 0 : (aMatch ? parseFloat(aMatch[1]) : Number.POSITIVE_INFINITY);
    const bIndex = b.name.includes('base_link') ? 0 : (bMatch ? parseFloat(bMatch[1]) : Number.POSITIVE_INFINITY);
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.name.localeCompare(b.name);
});

const getAllSortedMovableJoints = () => {
    if (!viewer.robot) return [];
    return sortMovableJoints(Object
        .values(viewer.robot.joints)
        .filter(joint => joint.isURDFJoint && joint.jointType !== 'fixed'));
};

const getSortedMovableJoints = () => {
    return getAllSortedMovableJoints()
        .filter(joint => !gripperControl?.containsJoint(joint));
};

const getRemoteSortedMovableJoints = () => {
    if (!viewer.robot) return [];
    return Object
        .keys(viewer.robot.joints)
        .filter(name => {
            const joint = viewer.robot.joints[name];
            return joint.isURDFJoint && joint.jointType !== 'fixed';
        })
        .sort()
        .map(name => viewer.robot.joints[name]);
};

const getAnimationEffector = () => {
    const joints = getRemoteSortedMovableJoints();
    if (joints.length === 0) return null;
    return joints.length >= 2 ? joints[joints.length - 2] : joints[joints.length - 1];
};

const getHumanoidArmProfile = () => {
    if (!viewer.robot) return null;
    const joints = viewer.robot.joints || {};
    const shoulderMount = joints.left_shoulder_mount || joints.right_shoulder_mount;
    const shoulderJoint = getSortedMovableJoints()[0];
    if (!shoulderMount) return null;
    return {
        side: joints.right_shoulder_mount ? 'right' : 'left',
        shoulderMount,
        shoulderJoint,
    };
};

const getCurrentAnimationTarget = () => {
    if (viewer.ikControls?.currentSolver) {
        return viewer.ikControls.currentSolver.getEffectorEndPoint();
    }
    if (viewer.ikControls?.selectedEffector) {
        return viewer.ikControls.selectedEffector.getWorldPosition(new THREE.Vector3());
    }
    return new THREE.Vector3(0.25, 0.25, 0);
};

const estimateAnimationReach = () => {
    const solverReach = viewer.ikControls?.currentSolver?.getChainReach?.();
    if (Number.isFinite(solverReach) && solverReach > 0.05) {
        return solverReach;
    }

    const humanoid = getHumanoidArmProfile();
    const effector = viewer.ikControls?.currentSolver?.getEffectorEndPoint?.() || getCurrentAnimationTarget();
    if (humanoid && effector) {
        const shoulder = humanoid.shoulderMount.getWorldPosition(new THREE.Vector3());
        const distance = shoulder.distanceTo(effector);
        if (distance > 0.05) {
            return distance;
        }
    }

    return 0.45;
};

const getHumanoidFrontVector = (humanoid) => {
    const shoulderJoint = humanoid.shoulderJoint || getSortedMovableJoints()[0];
    const worldUp = new THREE.Vector3(0, 1, 0);

    if (!shoulderJoint?.axis) {
        return new THREE.Vector3(1, 0, 0);
    }

    const shoulderAxis = shoulderJoint.axis
        .clone()
        .transformDirection(shoulderJoint.matrixWorld)
        .normalize();

    const front = humanoid.side === 'right'
        ? new THREE.Vector3().crossVectors(shoulderAxis, worldUp)
        : new THREE.Vector3().crossVectors(worldUp, shoulderAxis);

    if (front.length() < 0.05) {
        front.set(1, 0, 0);
    }

    front.y = 0;
    if (front.length() < 0.05) {
        front.set(1, 0, 0);
    }

    return front.normalize();
};

const getHumanoidWorkspaceBasis = (humanoid) => {
    const front = getHumanoidFrontVector(humanoid);
    const worldUp = new THREE.Vector3(0, 1, 0);
    const shoulderJoint = humanoid.shoulderJoint || getSortedMovableJoints()[0];
    let side = shoulderJoint?.axis
        ? shoulderJoint.axis.clone().transformDirection(shoulderJoint.matrixWorld)
        : new THREE.Vector3(0, 0, humanoid.side === 'right' ? -1 : 1);
    if (side.length() < 0.001) {
        side = new THREE.Vector3(0, 0, humanoid.side === 'right' ? -1 : 1);
    }
    side.y = 0;
    if (side.length() < 0.001) {
        side = new THREE.Vector3(0, 0, humanoid.side === 'right' ? -1 : 1);
    }
    side.normalize();
    if (humanoid.side === 'left' && side.z > 0) side.multiplyScalar(-1);
    if (humanoid.side === 'right' && side.z < 0) side.multiplyScalar(-1);

    front.normalize();

    const up = worldUp.clone();
    return { front, side, up };
};

const randomPointInFrontWorkspace = (humanoid, shoulder, reach) => {
    const { front, side, up } = getHumanoidWorkspaceBasis(humanoid);
    const minDistance = Math.max(0.08, reach * 0.1);
    const maxDistance = Math.max(minDistance + 0.05, reach * 0.78);
    const current = getCurrentAnimationTarget();
    const maxStep = Math.max(0.1, reach * 0.32);

    for (let attempt = 0; attempt < 24; attempt++) {
        const forwardDistance = reach * (0.12 + Math.random() * 0.48);
        const lateralDistance = reach * (0.05 + Math.random() * 0.48);
        const verticalDistance = reach * (-0.55 + Math.random() * 0.85);
        const offset = front
            .clone()
            .multiplyScalar(forwardDistance)
            .add(side.clone().multiplyScalar(lateralDistance))
            .add(up.clone().multiplyScalar(verticalDistance));
        const distance = offset.length();
        const candidate = shoulder.clone().add(offset);

        if (
            distance >= minDistance &&
            distance <= maxDistance &&
            offset.dot(front) > reach * 0.05 &&
            candidate.y <= shoulder.y + reach * 0.28 &&
            candidate.distanceTo(current) <= maxStep
        ) {
            return candidate;
        }
    }

    const currentOffset = current.clone().sub(shoulder);
    const currentForward = Math.max(reach * 0.14, currentOffset.dot(front));
    const clampedForward = Math.min(currentForward + reach * 0.18, reach * 0.62);
    return shoulder
        .clone()
        .add(front.multiplyScalar(clampedForward))
        .add(up.multiplyScalar(-reach * 0.18));
};

// Generate random point in cube workspace in front of robot
const generateRandomTarget = () => {
    const humanoid = getHumanoidArmProfile();
    if (humanoid) {
        const shoulder = humanoid.shoulderMount.getWorldPosition(new THREE.Vector3());
        const reach = estimateAnimationReach();
        return randomPointInFrontWorkspace(humanoid, shoulder, reach);
    }

    // Actual coordinate system: X = forward/back, Y = up/down, Z = left/right
    // Define a cube workspace in front of the robot

    // X range: forward in front of robot
    const minX = 0.1;
    const maxX = 0.45;

    // Y range: up/down (vertical)
    const minY = 0.1;
    const maxY = 0.45;

    // Z range: left/right (side to side)
    const minZ = -0.25;
    const maxZ = 0.25;

    // Generate random point in cube
    return new THREE.Vector3(
        minX + Math.random() * (maxX - minX),
        minY + Math.random() * (maxY - minY),
        minZ + Math.random() * (maxZ - minZ)
    );
};

const initializeAnimationTargets = () => {
    activeAnimationUsesHumanoidWorkspace = Boolean(getHumanoidArmProfile());

    if (activeAnimationUsesHumanoidWorkspace) {
        viewer.ikControls?.currentSolver?.resetRestPose?.();
        currentTarget.copy(getCurrentAnimationTarget());
        transitionProgress = 0;
    } else {
        currentTarget.copy(generateRandomTarget());
        transitionProgress = 1;
    }

    nextTarget = generateRandomTarget();
    smoothedTarget.copy(currentTarget);
    lastTransitionTime = performance.now();

    if (viewer.ikControls?.currentTarget) {
        viewer.ikControls.currentTarget.position.copy(currentTarget);
    }
};

const startAnimationSolver = () => {
    if (!viewer.robot || !viewer.ikControls) return;

    if (!viewer.ikMode) {
        ikModeToggle.classList.add('checked');
        viewer.ikMode = true;
        updateInteractionInstruction();
    }

    const endEffector = getAnimationEffector();
    if (!endEffector) return;

    viewer.ikControls.selectedEffector = endEffector;
    const solver = viewer.ikControls.createSolverForJoint(endEffector);
    if (!solver) return;

    initializeAnimationTargets();

    if (viewer.ikControls.currentTargetVisual) {
        viewer.ikControls.currentTargetVisual.visible = false;
    }
};

// init 2D UI and animation
const updateAngles = () => {
    if (!viewer.robot || !viewer.ikControls) {
        return;
    }

    // Don't run animation if user is manually dragging IK
    if (viewer.ikControls.isDragging) {
        return;
    }

    const now = performance.now();

    // Check if we need a new target
    if (transitionProgress >= 1) {
        // Start new transition
        if (activeAnimationUsesHumanoidWorkspace) {
            viewer.ikControls.currentSolver?.resetRestPose?.();
            currentTarget.copy(getCurrentAnimationTarget());
        } else {
            currentTarget.copy(nextTarget);
        }
        nextTarget = generateRandomTarget();
        transitionProgress = 0;
        lastTransitionTime = now;
    }

    // Update transition progress
    const elapsed = now - lastTransitionTime;
    transitionProgress = Math.min(1, elapsed / transitionDuration);

    // Smooth interpolation (ease in-out)
    const t = transitionProgress < 0.5
        ? 2 * transitionProgress * transitionProgress
        : 1 - Math.pow(-2 * transitionProgress + 2, 2) / 2;

    // Interpolate between current and next target
    const targetPos = new THREE.Vector3().lerpVectors(currentTarget, nextTarget, t);
    const solverTargetPos = activeAnimationUsesHumanoidWorkspace
        ? targetPos
        : smoothedTarget.lerp(targetPos, 0.16);

    // Apply IK if solver is active
    if (viewer.ikControls && viewer.ikControls.currentSolver && viewer.ikControls.currentTarget) {
        // Hide target visual during animation
        if (viewer.ikControls.currentTargetVisual) {
            viewer.ikControls.currentTargetVisual.visible = false;
        }

        // Update target position
        viewer.ikControls.currentTarget.position.copy(solverTargetPos);

        // Solve IK
        viewer.ikControls.currentSolver.solve();

        // Lock end effector orientation if needed
        if (viewer.ikControls.shouldLockSelectedJoint &&
            viewer.ikControls.selectedEffectorOriginalAngle !== null &&
            viewer.ikControls.selectedEffector) {
            viewer.ikControls.selectedEffector.setJointValue(
                viewer.ikControls.selectedEffectorOriginalAngle
            );
        }

        // Force visual update
        viewer.redraw();
    }
};

const updateLoop = () => {

    if (animToggle.classList.contains('checked')) {
        updateAngles();
        updateAnimatedGripper(performance.now());
    }

    requestAnimationFrame(updateLoop);

};

// Store robot manifest data
let robotManifestData = [];
let currentRobotInfo = null;

const escapeHtml = value => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Update robot info display
const setRobotInfoDisplay = robot => {
    document.getElementById('robot-name').textContent = robot?.name || '';
    const specsContainer = document.getElementById('robot-specs');

    if (!robot?.specs) {
        specsContainer.innerHTML = '';
        return;
    }

    const labels = {
        price: 'Price',
        payload: 'Payload',
        reach: 'Reach',
        repeatability: 'Repeatability',
        dof: 'DOF',
    };

    specsContainer.innerHTML = Object
        .entries(robot.specs)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `<div><strong>${escapeHtml(labels[key] || key)}:</strong> ${escapeHtml(value)}</div>`)
        .join('');
};

const updateRobotInfo = (robotName, fallback = null) => {
    const robot = robotManifestData.find(r => r.name === robotName) || fallback;
    currentRobotInfo = robot;
    setRobotInfoDisplay(robot);
};

const updateLoadedRobotInfo = () => {
    if (!viewer.robot || !currentRobotInfo?.custom) return;

    const movableJoints = Object
        .values(viewer.robot.joints)
        .filter(joint => joint.isURDFJoint && joint.jointType !== 'fixed');

    currentRobotInfo = {
        ...currentRobotInfo,
        specs: {
            Source: currentRobotInfo.path,
            Links: Object.keys(viewer.robot.links || {}).length,
            Joints: Object.keys(viewer.robot.joints || {}).length,
            DOF: movableJoints.length,
        },
    };
    setRobotInfoDisplay(currentRobotInfo);
};

// Load robot arms from manifest
const loadRobotManifest = async () => {
    try {
        const response = await fetch('./urdf/manifest.json');
        const robots = await response.json();
        robotManifestData = robots;

        const urdfOptionsContainer = document.querySelector('#urdf-options');

        robots.forEach(robot => {
            const li = document.createElement('li');
            li.setAttribute('urdf', robot.path);
            li.setAttribute('color', robot.color);
            li.setAttribute('data-robot-name', robot.name);
            li.textContent = robot.name;
            urdfOptionsContainer.appendChild(li);
        });

        updateList();

        // Load first robot by default
        if (robots.length > 0) {
            const firstRobot = urdfOptionsContainer.querySelector('li[urdf]');
            if (firstRobot) {
                firstRobot.dispatchEvent(new Event('click'));
            }
        }
    } catch (error) {
        console.error('Failed to load robot manifest:', error);
    }
};

const updateList = () => {

    document.querySelectorAll('#urdf-options li[urdf]').forEach(el => {

        el.onclick = e => {

            const urdf = e.target.getAttribute('urdf');
            const color = e.target.getAttribute('color');
            const robotName = e.target.getAttribute('data-robot-name');
            const isCustomRobot = e.target.getAttribute('data-custom-robot') === 'true';

            viewer.up = '+Z';
            document.getElementById('up-select').value = viewer.up;
            viewer.urdf = urdf;
            if (!isCustomRobot) {
                animToggle.classList.add('checked');
            }
            setColor(color);

            // Update robot info display
            updateRobotInfo(robotName, isCustomRobot ? {
                custom: true,
                name: robotName || urdf.split(/[\\\/]/).pop().replace(/\.urdf$/i, ''),
                path: urdf,
                specs: {
                    Source: urdf,
                },
            } : null);

        };

    });

};

// Load robots from manifest on startup
loadRobotManifest();

document.addEventListener('WebComponentsReady', () => {

    animToggle.addEventListener('click', () => {
        const willBeChecked = !animToggle.classList.contains('checked');
        animToggle.classList.toggle('checked');

        if (willBeChecked && viewer.robot && viewer.ikControls) {
            startAnimationSolver();
        } else if (!willBeChecked) {
            // Clean up animation's IK solver when turning off animation
            if (viewer.ikControls) {
                viewer.ikControls.cleanupCurrentSolver();
                viewer.ikControls.selectedEffector = null;
                viewer.ikControls.selectedEffectorOriginalAngle = null;
                viewer.ikControls.shouldLockSelectedJoint = false;
            }
        }
    });

    // stop the animation if user tried to manipulate the model
    viewer.addEventListener('manipulate-start', e => {
        animToggle.classList.remove('checked');
    });
    viewer.addEventListener('urdf-processed', e => {
        // Reset animation state when new robot loads
        transitionProgress = 1;

        // Start animation automatically since toggle starts checked
        if (animToggle.classList.contains('checked') && viewer.robot && viewer.ikControls) {
            // Wait a bit for IK controls to be ready
            setTimeout(() => startAnimationSolver(), 100);
        }
    });
    updateLoop();
    viewer.camera.position.set(-0.4, 0.4, 0.4);

});

updateInteractionInstruction();
syncAutocenterToggle();
