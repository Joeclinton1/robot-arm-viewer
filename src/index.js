/* globals */
import * as THREE from 'three';
import { registerDragEvents } from './dragAndDrop.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
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

});

viewer.addEventListener('ignore-limits-change', () => {

    Object
        .values(sliders)
        .forEach(sl => sl.update());

});

viewer.addEventListener('angle-change', e => {

    if (sliders[e.detail]) sliders[e.detail].update();

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
                const degMultiplier = radiansToggle.classList.contains('checked') ? 1.0 : DEG2RAD;
                viewer.setJointValue(joint.name, input.value * degMultiplier);
                li.update();
            });

            li.update();

            sliders[joint.name] = li;

        });

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
                new OBJLoader(manager).load(
                    path,
                    result => done(result),
                    null,
                    err => done(null, err),
                );
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
let transitionProgress = 1; // 0 to 1
let transitionDuration = 2000; // milliseconds
let lastTransitionTime = 0;

const getSortedMovableJoints = () => {
    if (!viewer.robot) return [];
    return Object
        .values(viewer.robot.joints)
        .filter(joint => joint.isURDFJoint && joint.jointType !== 'fixed')
        .sort((a, b) => {
            const aMatch = a.name.match(/(?:^|_to_)link(\d+)|base_link/);
            const bMatch = b.name.match(/(?:^|_to_)link(\d+)|base_link/);
            const aIndex = a.name.includes('base_link') ? 0 : (aMatch ? parseFloat(aMatch[1]) : Number.POSITIVE_INFINITY);
            const bIndex = b.name.includes('base_link') ? 0 : (bMatch ? parseFloat(bMatch[1]) : Number.POSITIVE_INFINITY);
            if (aIndex !== bIndex) return aIndex - bIndex;
            return a.name.localeCompare(b.name);
        });
};

const getAnimationEffector = () => {
    const joints = getSortedMovableJoints();
    if (joints.length === 0) return null;
    return joints[joints.length - 1];
};

const getHumanoidArmProfile = () => {
    if (!viewer.robot) return null;
    const joints = viewer.robot.joints || {};
    const shoulderMount = joints.left_shoulder_mount || joints.right_shoulder_mount;
    if (!shoulderMount) return null;
    return {
        side: joints.right_shoulder_mount ? 'right' : 'left',
        shoulderMount,
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
    const shoulderJoint = getSortedMovableJoints()[0];
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

const randomUnitVectorInFrontOfArm = (humanoid) => {
    const front = getHumanoidFrontVector(humanoid);
    const worldUp = new THREE.Vector3(0, 1, 0);
    let side = new THREE.Vector3().crossVectors(front, worldUp);
    if (side.length() < 0.001) {
        side = new THREE.Vector3(0, 0, humanoid.side === 'right' ? -1 : 1);
    }
    side.normalize();

    front.normalize();

    const up = new THREE.Vector3().crossVectors(front, side).normalize();
    const lateralOffset = (Math.random() - 0.5) * 1.0;
    const verticalOffset = (Math.random() - 0.45) * 0.85;
    const forwardWeight = 1.0 + Math.random() * 0.65;

    return front
        .clone()
        .multiplyScalar(forwardWeight)
        .add(side.multiplyScalar(lateralOffset))
        .add(up.multiplyScalar(verticalOffset))
        .normalize();
};

// Generate random point in cube workspace in front of robot
const generateRandomTarget = () => {
    const humanoid = getHumanoidArmProfile();
    if (humanoid) {
        const shoulder = humanoid.shoulderMount.getWorldPosition(new THREE.Vector3());
        const reach = estimateAnimationReach();
        const minRadius = Math.max(0.12, reach * 0.22);
        const maxRadius = Math.max(minRadius + 0.05, reach * 0.96);
        const radius = minRadius + Math.random() * (maxRadius - minRadius);
        const direction = randomUnitVectorInFrontOfArm(humanoid);

        return shoulder.clone().add(direction.multiplyScalar(radius));
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
    viewer.ikControls?.currentSolver?.resetRestPose?.();
    currentTarget.copy(getCurrentAnimationTarget());
    nextTarget = generateRandomTarget();
    transitionProgress = 0;
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
        viewer.ikControls.currentSolver?.resetRestPose?.();
        currentTarget.copy(nextTarget);
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

    // Apply IK if solver is active
    if (viewer.ikControls && viewer.ikControls.currentSolver && viewer.ikControls.currentTarget) {
        // Hide target visual during animation
        if (viewer.ikControls.currentTargetVisual) {
            viewer.ikControls.currentTargetVisual.visible = false;
        }

        // Update target position
        viewer.ikControls.currentTarget.position.copy(targetPos);

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
