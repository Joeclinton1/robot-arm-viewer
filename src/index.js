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
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 1 / DEG2RAD;
let sliders = {};

// Create axis helper
let axesHelper = null;

// Banana for scale
let banana = null;

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

    registerDragEvents(viewer, () => {
        setColor('#263238');
        animToggle.classList.remove('checked');
        updateList();
    });

});

// Animation state for IK targeting
let currentTarget = new THREE.Vector3();
let nextTarget = new THREE.Vector3();
let transitionProgress = 1; // 0 to 1
let transitionDuration = 2000; // milliseconds
let lastTransitionTime = 0;

// Generate random point in cube workspace in front of robot
const generateRandomTarget = () => {
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

// Update robot info display
const updateRobotInfo = (robotName) => {
    const robot = robotManifestData.find(r => r.name === robotName);
    if (!robot) return;

    // Update robot name
    document.getElementById('robot-name').textContent = robot.name;

    // Update specs
    const specsContainer = document.getElementById('robot-specs');
    if (robot.specs) {
        specsContainer.innerHTML = `
            <div><strong>Price:</strong> ${robot.specs.price}</div>
            <div><strong>Payload:</strong> ${robot.specs.payload}</div>
            <div><strong>Reach:</strong> ${robot.specs.reach}</div>
            <div><strong>Repeatability:</strong> ${robot.specs.repeatability}</div>
        `;
    } else {
        specsContainer.innerHTML = '';
    }
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

        el.addEventListener('click', e => {

            const urdf = e.target.getAttribute('urdf');
            const color = e.target.getAttribute('color');
            const robotName = e.target.getAttribute('data-robot-name');

            viewer.up = '+Z';
            document.getElementById('up-select').value = viewer.up;
            viewer.urdf = urdf;
            animToggle.classList.add('checked');
            setColor(color);

            // Update robot info display
            updateRobotInfo(robotName);

        });

    });

};

// Load robots from manifest on startup
loadRobotManifest();

document.addEventListener('WebComponentsReady', () => {

    animToggle.addEventListener('click', () => {
        const willBeChecked = !animToggle.classList.contains('checked');
        animToggle.classList.toggle('checked');

        if (willBeChecked && viewer.robot && viewer.ikControls) {
            // Enable IK mode if not already enabled
            if (!viewer.ikMode) {
                ikModeToggle.classList.add('checked');
                viewer.ikMode = true;
            }

            // Initialize IK animation - pick joint5 as effector
            const joints = Object.keys(viewer.robot.joints)
                .filter(name => {
                    const j = viewer.robot.joints[name];
                    return j.isURDFJoint && j.jointType !== 'fixed';
                })
                .sort()
                .map(name => viewer.robot.joints[name]);

            if (joints.length > 0) {
                // Use second-to-last joint (joint5) instead of last (joint6)
                const endEffector = joints.length >= 2 ? joints[joints.length - 2] : joints[joints.length - 1];

                // Setup IK solver for end effector
                viewer.ikControls.selectedEffector = endEffector;
                const solver = viewer.ikControls.createSolverForJoint(endEffector);

                // Initialize targets
                if (viewer.ikControls.currentTarget) {
                    currentTarget = generateRandomTarget();
                    nextTarget = generateRandomTarget();
                    viewer.ikControls.currentTarget.position.copy(currentTarget);
                    transitionProgress = 1;
                }

                // Hide target visual during animation
                if (viewer.ikControls.currentTargetVisual) {
                    viewer.ikControls.currentTargetVisual.visible = false;
                }
            }
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
            // Enable IK mode
            if (!viewer.ikMode) {
                ikModeToggle.classList.add('checked');
                viewer.ikMode = true;
            }

            // Wait a bit for IK controls to be ready
            setTimeout(() => {
                // Find end effector - use joint5 instead of joint6
                const joints = Object.keys(viewer.robot.joints)
                    .filter(name => {
                        const j = viewer.robot.joints[name];
                        return j.isURDFJoint && j.jointType !== 'fixed';
                    })
                    .sort()
                    .map(name => viewer.robot.joints[name]);

                if (joints.length > 0) {
                    // Use second-to-last joint (joint5)
                    const endEffector = joints.length >= 2 ? joints[joints.length - 2] : joints[joints.length - 1];

                    // Simulate clicking on end effector
                    viewer.ikControls.selectedEffector = endEffector;
                    viewer.ikControls.createSolverForJoint(endEffector);

                    // Initialize targets
                    if (viewer.ikControls.currentTarget) {
                        currentTarget = generateRandomTarget();
                        nextTarget = generateRandomTarget();
                        viewer.ikControls.currentTarget.position.copy(currentTarget);
                        transitionProgress = 1;
                    }

                    // Hide target visual during animation
                    if (viewer.ikControls.currentTargetVisual) {
                        viewer.ikControls.currentTargetVisual.visible = false;
                    }
                }
            }, 100);
        }
    });
    updateLoop();
    viewer.camera.position.set(-0.4, 0.4, 0.4);

});
