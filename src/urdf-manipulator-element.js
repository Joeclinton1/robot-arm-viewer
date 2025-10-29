import * as THREE from 'three';
import URDFViewer from './urdf-viewer-element.js';
import { PointerURDFDragControls } from './URDFDragControls.js';
import { URDFIKControls } from './URDFIKControls.js';

// urdf-manipulator element
// Displays a URDF model that can be manipulated with the mouse

// Events
// joint-mouseover: Fired when a joint is hovered over
// joint-mouseout: Fired when a joint is no longer hovered over
// manipulate-start: Fires when a joint is manipulated
// manipulate-end: Fires when a joint is done being manipulated
export default
class URDFManipulator extends URDFViewer {

    static get observedAttributes() {

        return ['highlight-color', 'ik-mode', ...super.observedAttributes];

    }

    get disableDragging() { return this.hasAttribute('disable-dragging'); }
    set disableDragging(val) { val ? this.setAttribute('disable-dragging', !!val) : this.removeAttribute('disable-dragging'); }

    get highlightColor() { return this.getAttribute('highlight-color') || '#FFFFFF'; }
    set highlightColor(val) { val ? this.setAttribute('highlight-color', val) : this.removeAttribute('highlight-color'); }

    get ikMode() { return this.hasAttribute('ik-mode'); }
    set ikMode(val) { val ? this.setAttribute('ik-mode', !!val) : this.removeAttribute('ik-mode'); }

    constructor(...args) {

        super(...args);

        // The highlight material (using PBR for consistency)
        this.highlightMaterial =
            new THREE.MeshStandardMaterial({
                roughness: 0.3,
                metalness: 0.5,
                color: this.highlightColor,
                emissive: this.highlightColor,
                emissiveIntensity: 0.25,
            });

        const isJoint = j => {

            return j.isURDFJoint && j.jointType !== 'fixed';

        };

        // Highlight the link geometry under a joint
        const highlightLinkGeometry = (m, revert) => {

            const traverse = c => {

                // Set or revert the highlight color
                if (c.type === 'Mesh') {

                    if (revert) {

                        c.material = c.__origMaterial;
                        delete c.__origMaterial;

                    } else {

                        c.__origMaterial = c.material;

                        // Update highlight material with environment map if available
                        if (this.envMap && !this.highlightMaterial.envMap) {
                            this.highlightMaterial.envMap = this.envMap;
                            this.highlightMaterial.envMapIntensity = 1.0;
                            this.highlightMaterial.needsUpdate = true;
                        }

                        c.material = this.highlightMaterial;

                    }

                }

                // Look into the children and stop if the next child is
                // another joint
                if (c === m || !isJoint(c)) {

                    for (let i = 0; i < c.children.length; i++) {

                        const child = c.children[i];
                        if (!child.isURDFCollider) {

                            traverse(c.children[i]);

                        }

                    }

                }

            };

            traverse(m);

        };

        const el = this.renderer.domElement;

        const dragControls = new PointerURDFDragControls(this.scene, this.camera, el);
        dragControls.onDragStart = joint => {

            this.dispatchEvent(new CustomEvent('manipulate-start', { bubbles: true, cancelable: true, detail: joint.name }));
            this.controls.enabled = false;
            this.redraw();

        };
        dragControls.onDragEnd = joint => {

            this.dispatchEvent(new CustomEvent('manipulate-end', { bubbles: true, cancelable: true, detail: joint.name }));
            this.controls.enabled = true;
            this.redraw();

        };
        dragControls.updateJoint = (joint, angle) => {

            this.setJointValue(joint.name, angle);

        };
        dragControls.onHover = joint => {

            highlightLinkGeometry(joint, false);
            this.dispatchEvent(new CustomEvent('joint-mouseover', { bubbles: true, cancelable: true, detail: joint.name }));
            this.redraw();

        };
        dragControls.onUnhover = joint => {

            highlightLinkGeometry(joint, true);
            this.dispatchEvent(new CustomEvent('joint-mouseout', { bubbles: true, cancelable: true, detail: joint.name }));
            this.redraw();

        };

        this.dragControls = dragControls;
        
        // Setup IK controls
        this.ikControls = null;
        this._setupIKControls();

    }

    disconnectedCallback() {

        super.disconnectedCallback();
        this.dragControls.dispose();
        if (this.ikControls) {
            this.ikControls.dispose();
        }

    }

    attributeChangedCallback(attr, oldval, newval) {

        super.attributeChangedCallback(attr, oldval, newval);

        switch (attr) {

            case 'highlight-color':
                this.highlightMaterial.color.set(this.highlightColor);
                this.highlightMaterial.emissive.set(this.highlightColor);
                break;
                
            case 'ik-mode':
                this._updateControlMode();
                break;

        }

    }
    
    _setupIKControls() {
        if (this.robot && !this.ikControls) {
            this.ikControls = new URDFIKControls(this.robot, this.scene, this.camera, this.renderer.domElement, this);
            this._updateControlMode();
        }
    }
    
    _updateControlMode() {
        const ikMode = this.ikMode;
        console.log('_updateControlMode called, ikMode:', ikMode);
        console.log('ikControls exists:', !!this.ikControls);
        
        // Enable/disable appropriate controls
        this.dragControls.enabled = !ikMode;
        
        if (this.ikControls) {
            console.log('Calling ikControls.setEnabled with:', ikMode);
            this.ikControls.setEnabled(ikMode);
            
            if (ikMode) {
                // Update IK effector positions when switching to IK mode
                this.ikControls.updateEffectorPositions();
            }
        } else {
            console.warn('ikControls not available in _updateControlMode');
        }
        
        this.redraw();
    }

};

// Override the urdf-processed event to setup IK when robot loads
const originalAddEventListener = URDFManipulator.prototype.addEventListener;
URDFManipulator.prototype.addEventListener = function(type, listener, options) {
    if (type === 'urdf-processed') {
        const wrappedListener = (event) => {
            listener.call(this, event);
            // Setup IK controls after robot is loaded
            this._setupIKControls();
        };
        return originalAddEventListener.call(this, type, wrappedListener, options);
    }
    return originalAddEventListener.call(this, type, listener, options);
};
