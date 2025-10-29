import { Raycaster, Vector3, Vector2, Object3D, SphereGeometry, MeshBasicMaterial, Mesh } from 'three';

// Calculate the end point for a joint (furthest geometry from joint in its subtree)
function calculateEndPoint(joint) {
    let furthestPoint = new Vector3();
    let maxDistance = 0;

    joint.traverse(child => {
        if (child.isMesh && child.geometry) {
            const geometry = child.geometry;
            if (!geometry.boundingBox) {
                geometry.computeBoundingBox();
            }
            if (geometry.boundingBox) {
                const bbox = geometry.boundingBox;
                const center = bbox.getCenter(new Vector3());

                // Transform to world space
                const worldCenter = center.clone();
                child.localToWorld(worldCenter);

                const jointWorldPos = new Vector3();
                joint.getWorldPosition(jointWorldPos);

                const distance = jointWorldPos.distanceTo(worldCenter);
                if (distance > maxDistance) {
                    maxDistance = distance;
                    // Store in local space relative to joint
                    joint.worldToLocal(worldCenter);
                    furthestPoint.copy(worldCenter);
                }
            }
        }
    });

    // If no geometry found, use a default offset
    if (maxDistance === 0) {
        furthestPoint.set(0, 0, 0.1);
    }

    return furthestPoint;
}

// Find all movable joints that can be used for IK
function findAllMovableJoints(robot) {
    const movableJoints = [];

    robot.traverse(obj => {
        if (obj.isURDFJoint && obj.jointType !== 'fixed') {
            movableJoints.push(obj);
        }
    });

    return movableJoints;
}

// Check if a joint has any movable children
function hasMovableChildren(joint) {
    let hasMovable = false;
    joint.traverse(child => {
        if (child !== joint && child.isURDFJoint && child.jointType !== 'fixed') {
            hasMovable = true;
        }
    });
    return hasMovable;
}

// Build IK chain from end effector back to root
// If the joint has movable children, include it in the chain (it should rotate)
// If the joint has no movable children (end effector), exclude it from the chain (it shouldn't rotate)
function buildIKChain(endEffector, includeEndEffector = false) {
    const chain = [];
    let current = includeEndEffector ? endEffector : endEffector.parent;

    // Traverse up the hierarchy to collect movable joints
    while (current && current.parent) {
        if (current.isURDFJoint && current.jointType !== 'fixed') {
            chain.unshift({
                joint: current,
                originalAngle: current.angle
            });
        }
        current = current.parent;
    }

    return chain;
}

// Improved CCD IK solver for URDF joints
class SimpleIKSolver {
    constructor(chain, target, effector, updateCallback) {
        this.chain = chain;
        this.target = target;
        this.effector = effector;
        this.updateCallback = updateCallback; // Callback to update UI when joints change
        this.tolerance = 0.01; // Slightly relaxed for smoother convergence
        this.maxIterations = 15;
        this.dampingFactor = 0.5; // Increased for smoother motion
        this.maxAngleChangePerIteration = 0.15; // Limit angle changes for smoothness
        this.smoothingFactor = 0.3; // For interpolating towards target angles

        // Store initial orientation to preserve it
        this.initialOrientation = new Vector3();
        this.effector.getWorldDirection(this.initialOrientation);
        this.initialOrientation.normalize();

        // Store previous joint angles for smoothing
        this.previousAngles = new Map();
        this.chain.forEach(chainItem => {
            this.previousAngles.set(chainItem.joint, chainItem.joint.angle);
        });

        // Orientation preservation weight (0 = ignore orientation, 1 = strongly preserve)
        this.orientationWeight = 0.3;
    }
    
    getEffectorEndPoint() {
        // Use the stored end point if available, otherwise use joint position
        if (this.effector.endPoint) {
            const worldEndPoint = this.effector.endPoint.clone();
            this.effector.localToWorld(worldEndPoint);
            return worldEndPoint;
        } else {
            return this.effector.getWorldPosition(new Vector3());
        }
    }
    
    solve() {
        if (this.chain.length === 0) return;

        const targetPos = new Vector3();
        this.target.getWorldPosition(targetPos);

        // Simple CCD (Cyclic Coordinate Descent) approach
        for (let iteration = 0; iteration < this.maxIterations; iteration++) {
            let totalChange = 0;

            // Work backwards through the chain (from effector to base)
            for (let i = this.chain.length - 1; i >= 0; i--) {
                const joint = this.chain[i].joint;

                if (joint.jointType !== 'revolute' && joint.jointType !== 'continuous') {
                    continue; // Skip non-revolute joints for now
                }

                // Get current end effector position (actual tip, not joint)
                const effectorPos = this.getEffectorEndPoint();

                const jointPos = new Vector3();
                joint.getWorldPosition(jointPos);

                // Skip if joint and effector are at same position
                if (jointPos.distanceTo(effectorPos) < 0.001) continue;

                // Calculate vectors from joint to effector and joint to target
                const toEffector = effectorPos.clone().sub(jointPos);
                const toTarget = targetPos.clone().sub(jointPos);

                // Skip if vectors are too small
                if (toEffector.length() < 0.001 || toTarget.length() < 0.001) continue;

                toEffector.normalize();
                toTarget.normalize();

                // Calculate angle between vectors
                const dot = Math.max(-1, Math.min(1, toEffector.dot(toTarget)));
                const angle = Math.acos(dot);

                // Skip if already aligned
                if (angle < 0.001) continue;

                // Get joint axis in world space
                const axis = new Vector3();
                if (joint.axis) {
                    axis.copy(joint.axis);
                } else {
                    axis.set(0, 0, 1);
                }
                const axisWorld = axis.clone().transformDirection(joint.matrixWorld).normalize();

                // Calculate rotation direction
                const cross = toEffector.clone().cross(toTarget);
                const direction = Math.sign(cross.dot(axisWorld));

                // Apply damping and calculate new angle
                let deltaAngle = direction * angle * this.dampingFactor;

                // Clamp the maximum angle change per iteration for smoothness
                deltaAngle = Math.max(-this.maxAngleChangePerIteration,
                                     Math.min(this.maxAngleChangePerIteration, deltaAngle));

                // Calculate target angle
                let targetAngle = joint.angle + deltaAngle;

                // Apply joint limits
                if (joint.limit) {
                    const range = joint.limit.upper - joint.limit.lower;
                    if (range > 0) {
                        targetAngle = Math.max(joint.limit.lower, Math.min(joint.limit.upper, targetAngle));
                    }
                }

                // Smooth interpolation from previous angle to target angle
                const previousAngle = this.previousAngles.get(joint) || joint.angle;
                let newAngle = previousAngle + (targetAngle - previousAngle) * this.smoothingFactor;

                // Apply joint limits again after smoothing
                if (joint.limit) {
                    const range = joint.limit.upper - joint.limit.lower;
                    if (range > 0) {
                        newAngle = Math.max(joint.limit.lower, Math.min(joint.limit.upper, newAngle));
                    }
                }

                // Only apply if the change is significant
                const actualDelta = Math.abs(newAngle - joint.angle);
                if (actualDelta > 0.0001) {
                    joint.setJointValue(newAngle);
                    this.previousAngles.set(joint, newAngle);
                    totalChange += actualDelta;

                    // Notify UI that joint angle changed
                    if (this.updateCallback) {
                        this.updateCallback(joint);
                    }
                }
            }

            // Check if we should apply orientation correction
            if (this.orientationWeight > 0) {
                this.correctOrientation();
            }

            // Check convergence using actual end point
            const finalEffectorPos = this.getEffectorEndPoint();
            const distance = finalEffectorPos.distanceTo(targetPos);

            if (distance < this.tolerance || totalChange < 0.005) {
                break;
            }
        }
    }

    // Apply gentle orientation correction to prevent end effector from twisting
    correctOrientation() {
        const currentOrientation = new Vector3();
        this.effector.getWorldDirection(currentOrientation);
        currentOrientation.normalize();

        // Calculate how much the orientation has drifted
        const orientationDot = currentOrientation.dot(this.initialOrientation);

        // If orientation has changed significantly, try to correct it
        if (orientationDot < 0.98) { // Allow some drift
            // Find joints that can affect orientation (usually the last few joints)
            const orientationJoints = this.chain.slice(-2); // Last 2 joints typically control orientation

            for (const chainItem of orientationJoints) {
                const joint = chainItem.joint;

                if (joint.jointType !== 'revolute' && joint.jointType !== 'continuous') {
                    continue;
                }

                // Get joint axis
                const axis = new Vector3();
                if (joint.axis) {
                    axis.copy(joint.axis);
                } else {
                    axis.set(0, 0, 1);
                }
                const axisWorld = axis.clone().transformDirection(joint.matrixWorld).normalize();

                // Calculate correction angle
                const cross = currentOrientation.clone().cross(this.initialOrientation);
                const correctionDirection = Math.sign(cross.dot(axisWorld));

                // Apply small correction weighted by orientation preservation parameter
                const correctionAngle = correctionDirection * 0.02 * this.orientationWeight;
                let newAngle = joint.angle + correctionAngle;

                // Apply joint limits
                if (joint.limit) {
                    const range = joint.limit.upper - joint.limit.lower;
                    if (range > 0) {
                        newAngle = Math.max(joint.limit.lower, Math.min(joint.limit.upper, newAngle));
                    }
                }

                joint.setJointValue(newAngle);
                this.previousAngles.set(joint, newAngle);

                // Notify UI that joint angle changed
                if (this.updateCallback) {
                    this.updateCallback(joint);
                }
            }
        }
    }
}

export class URDFIKControls {
    constructor(robot, scene, camera, domElement, viewer) {
        this.robot = robot;
        this.scene = scene;
        this.camera = camera;
        this.domElement = domElement;
        this.viewer = viewer; // Reference to the viewer element for dispatching events
        this.enabled = false;

        this.raycaster = new Raycaster();
        this.mouse = new Vector2();
        this.isDragging = false;
        this.selectedEffector = null;
        this.selectedEffectorOriginalAngle = null; // Store original angle to keep it locked (only for end effectors)
        this.shouldLockSelectedJoint = false; // Whether to lock the selected joint's rotation
        this.hovered = null;
        this.hitDistance = -1;
        this.initialGrabPoint = new Vector3();
        this.grabOffset = new Vector3();

        // Store current active IK solver (only one at a time now)
        this.currentSolver = null;
        this.currentTarget = null;
        this.currentTargetVisual = null;

        // All movable joints that can be clicked for IK
        this.movableJoints = [];

        this.setupIK();
        this.setupEventListeners();
    }
    
    setupIK() {
        if (!this.robot) return;

        // Find all movable joints
        this.movableJoints = findAllMovableJoints(this.robot);
    }

    // Update the robot reference when switching robots
    updateRobot(robot) {
        this.robot = robot;
        // Clean up any existing solver from old robot
        this.cleanupCurrentSolver();
        this.selectedEffector = null;
        this.selectedEffectorOriginalAngle = null;
        this.shouldLockSelectedJoint = false;
        // Rebuild movable joints list for new robot
        this.setupIK();
    }

    // Create IK solver for a specific joint dynamically
    createSolverForJoint(joint) {
        // Clean up any existing solver
        this.cleanupCurrentSolver();

        // Calculate end point for this joint (treat it and its children as rigid body)
        joint.endPoint = calculateEndPoint(joint);

        // Check if this joint has movable children
        const hasChildren = hasMovableChildren(joint);

        // If joint has no movable children, it's an end effector - don't include it in chain and lock its rotation
        // If joint has movable children, include it in chain so it can rotate
        const includeInChain = hasChildren;
        this.shouldLockSelectedJoint = !hasChildren;

        // Build IK chain from this joint back to root
        const chain = buildIKChain(joint, includeInChain);

        if (chain.length === 0) {
            console.warn('No IK chain could be built for joint:', joint.name);
            return null;
        }

        // Create target object at the end point
        const target = new Object3D();
        const worldEndPoint = joint.endPoint.clone();
        joint.localToWorld(worldEndPoint);
        target.position.copy(worldEndPoint);
        this.scene.add(target);

        // Create visual target sphere
        const targetGeometry = new SphereGeometry(0.01);
        const targetMaterial = new MeshBasicMaterial({
            color: 0x00ff00,
            transparent: true,
            opacity: 0.8
        });
        const targetVisual = new Mesh(targetGeometry, targetMaterial);
        targetVisual.position.copy(target.position);
        targetVisual.visible = this.enabled;
        this.scene.add(targetVisual);

        // Create IK solver with callback to update UI sliders
        const updateCallback = (joint) => {
            if (this.viewer) {
                // Dispatch event to update sliders (don't redraw here for performance)
                this.viewer.dispatchEvent(new CustomEvent('angle-change', {
                    bubbles: true,
                    cancelable: true,
                    detail: joint.name
                }));
            }
        };

        const solver = new SimpleIKSolver(chain, target, joint, updateCallback);

        // Store current solver
        this.currentSolver = solver;
        this.currentTarget = target;
        this.currentTargetVisual = targetVisual;

        console.log(`Created IK solver for joint: ${joint.name} with ${chain.length} joints in chain`);

        return solver;
    }

    // Clean up the current solver and its visuals
    cleanupCurrentSolver() {
        if (this.currentTarget) {
            this.scene.remove(this.currentTarget);
            this.currentTarget = null;
        }

        if (this.currentTargetVisual) {
            this.scene.remove(this.currentTargetVisual);
            if (this.currentTargetVisual.geometry) this.currentTargetVisual.geometry.dispose();
            if (this.currentTargetVisual.material) this.currentTargetVisual.material.dispose();
            this.currentTargetVisual = null;
        }

        this.currentSolver = null;
    }
    
    setupEventListeners() {
        this._onMouseDown = this.onMouseDown.bind(this);
        this._onMouseMove = this.onMouseMove.bind(this);
        this._onMouseUp = this.onMouseUp.bind(this);
        
        this.domElement.addEventListener('mousedown', this._onMouseDown);
        this.domElement.addEventListener('mousemove', this._onMouseMove);
        this.domElement.addEventListener('mouseup', this._onMouseUp);
    }
    
    update() {
        if (!this.enabled || this.isDragging) return;

        let hoveredJoint = null;
        const intersections = this.raycaster.intersectObject(this.scene, true);
        if (intersections.length !== 0) {
            const hit = intersections[0];
            this.hitDistance = hit.distance;

            // Find nearest joint - now ANY movable joint can be used for IK
            let hitObject = hit.object;
            while (hitObject) {
                if (hitObject.isURDFJoint && hitObject.jointType !== 'fixed') {
                    // Check if this is one of our movable joints
                    if (this.movableJoints.includes(hitObject)) {
                        hoveredJoint = hitObject;
                    }
                    break;
                }
                hitObject = hitObject.parent;
            }

            this.initialGrabPoint.copy(hit.point);
        }

        if (hoveredJoint !== this.hovered) {
            this.hovered = hoveredJoint;

            // Show which joint we're hovering over
            if (hoveredJoint) {
                // Hovering logic handled by event dispatching
            }
        }
    }
    
    updateMouse(event) {
        const rect = this.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }
    
    onMouseDown(event) {
        if (!this.enabled) return;

        this.updateMouse(event);
        this.raycaster.setFromCamera(this.mouse, this.camera);
        this.update();

        if (this.hovered) {
            this.selectedEffector = this.hovered;
            this.isDragging = true;

            // Store the original angle of the selected joint to keep it locked
            this.selectedEffectorOriginalAngle = this.selectedEffector.angle;

            // Calculate where the user actually clicked (the grab point)
            const intersections = this.raycaster.intersectObject(this.scene, true);
            if (intersections.length > 0) {
                this.initialGrabPoint.copy(intersections[0].point);
            }

            // Create a new IK solver for the selected joint
            const solver = this.createSolverForJoint(this.selectedEffector);

            if (solver && this.currentTarget) {
                // Reset initial orientation when starting to drag
                this.selectedEffector.getWorldDirection(solver.initialOrientation);
                solver.initialOrientation.normalize();

                // Calculate offset from effector end point to grab point
                const currentEndPoint = solver.getEffectorEndPoint();
                this.grabOffset.subVectors(this.initialGrabPoint, currentEndPoint);

                // Set target to the grab point (where user clicked)
                this.currentTarget.position.copy(this.initialGrabPoint);

                // Update visual target too
                if (this.currentTargetVisual) {
                    this.currentTargetVisual.position.copy(this.initialGrabPoint);
                    this.currentTargetVisual.visible = true;
                }
            }

            console.log('Started dragging joint:', this.selectedEffector.name,
                       'locked:', this.shouldLockSelectedJoint,
                       'angle:', this.selectedEffectorOriginalAngle);
        }
    }
    
    onMouseMove(event) {
        if (!this.enabled) return;

        this.updateMouse(event);
        this.raycaster.setFromCamera(this.mouse, this.camera);

        if (this.isDragging && this.selectedEffector) {
            // Handle IK dragging
            if (this.currentTarget && this.currentSolver) {
                // Project mouse to the same depth as the initial grab point
                const distance = this.camera.position.distanceTo(this.initialGrabPoint);
                const newGrabPoint = new Vector3();
                this.raycaster.ray.at(distance, newGrabPoint);

                // The target should be positioned so that the end effector + offset reaches the new grab point
                // target = newGrabPoint - offset
                const newTarget = newGrabPoint.clone().sub(this.grabOffset);
                this.currentTarget.position.copy(newTarget);

                // Update visual target to show the actual grab point (where mouse should be)
                if (this.currentTargetVisual) {
                    this.currentTargetVisual.position.copy(newGrabPoint);
                }

                // Solve IK
                this.currentSolver.solve();

                // Lock the selected joint back to its original angle (only if it's an end effector)
                if (this.shouldLockSelectedJoint && this.selectedEffectorOriginalAngle !== null) {
                    this.selectedEffector.setJointValue(this.selectedEffectorOriginalAngle);
                }

                // Redraw once after solving (more efficient than per-joint)
                if (this.viewer && this.viewer.redraw) {
                    this.viewer.redraw();
                }
            }
        } else {
            // Update hover detection
            this.update();
        }
    }
    
    onMouseUp(event) {
        if (!this.enabled) return;

        this.updateMouse(event);
        this.raycaster.setFromCamera(this.mouse, this.camera);
        this.update();

        this.isDragging = false;
        this.selectedEffector = null;
        this.selectedEffectorOriginalAngle = null;
        this.shouldLockSelectedJoint = false;

        // Keep the solver active but hide the visual target when not dragging
        if (this.currentTargetVisual) {
            this.currentTargetVisual.visible = false;
        }
    }
    
    setEnabled(enabled) {
        this.enabled = enabled;

        // Show/hide current target visual if it exists
        if (this.currentTargetVisual) {
            this.currentTargetVisual.visible = enabled && this.isDragging;
        }

        if (!enabled) {
            this.isDragging = false;
            this.selectedEffector = null;
            this.selectedEffectorOriginalAngle = null;
            this.shouldLockSelectedJoint = false;
            // Clean up solver when disabled
            this.cleanupCurrentSolver();
        }
    }

    updateEffectorPositions() {
        // Update target position to match current effector position if active
        if (this.currentTarget && this.selectedEffector) {
            const worldPos = this.selectedEffector.getWorldPosition(new Vector3());
            this.currentTarget.position.copy(worldPos);
        }
    }
    
    dispose() {
        this.domElement.removeEventListener('mousedown', this._onMouseDown);
        this.domElement.removeEventListener('mousemove', this._onMouseMove);
        this.domElement.removeEventListener('mouseup', this._onMouseUp);

        // Clean up current solver and visuals
        this.cleanupCurrentSolver();

        this.movableJoints = [];
    }
}