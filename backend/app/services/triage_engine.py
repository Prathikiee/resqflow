from typing import List, Dict, Any

class TriageAssessmentResult:
    def __init__(
        self,
        triage_level: str,
        triage_color: str,
        triage_score: int,
        required_ambulance_type: str,
        justifications: List[str],
        recommended_specialty: str = "Emergency Medicine",
    ):
        self.triage_level = triage_level
        self.triage_color = triage_color
        self.triage_score = triage_score
        self.required_ambulance_type = required_ambulance_type
        self.justifications = justifications
        self.recommended_specialty = recommended_specialty

    def to_dict(self) -> Dict[str, Any]:
        return {
            "triage_level": self.triage_level,
            "triage_color": self.triage_color,
            "triage_score": self.triage_score,
            "required_ambulance_type": self.required_ambulance_type,
            "justifications": self.justifications,
            "recommended_specialty": self.recommended_specialty,
            "protocol_reference": "Operational Emergency Medical Dispatch (MPDS-Aligned Heuristic)",
            "disclaimer": (
                "Transparent rule-based prioritization for rapid ambulance routing. "
                "Not clinically validated for diagnostic accuracy."
            ),
        }


def assess_incident_severity(
    chief_complaint: str,
    consciousness_level: str = "Alert",
    breathing_status: str = "Normal",
    severe_bleeding: bool = False,
    chest_pain: bool = False,
    suspected_stroke: bool = False,
    severe_trauma: bool = False,
    patient_age: int = None,
) -> TriageAssessmentResult:
    """
    Evaluates caller incident inputs using transparent rule-based heuristics.
    Categorizes into:
      - Priority 1 (RED / Critical): Immediate life threat, mandates Advanced Life Support (ALS).
      - Priority 2 (YELLOW / Urgent): Severe condition with imminent risk, requires urgent dispatch.
      - Priority 3 (GREEN / Standard): Stable presentation, suitable for Basic Life Support (BLS).
    """
    justifications: List[str] = []
    p1_triggers = 0
    p2_triggers = 0
    recommended_specialty = "Emergency Medicine"

    complaint_lower = (chief_complaint or "").lower()

    # Rule 1: Consciousness / Neurological Status (AVPU Heuristic)
    c_status = (consciousness_level or "Alert").strip().capitalize()
    if c_status in ["Unresponsive", "Pain"]:
        p1_triggers += 2
        justifications.append(f"Critical Neurological Flag: Patient is {c_status} (AVPU scale). Immediate airway compromise risk.")
    elif c_status == "Voice":
        p2_triggers += 1
        justifications.append("Altered Mental Status: Patient responsive only to verbal stimulus.")

    # Rule 2: Respiratory Status
    b_status = (breathing_status or "Normal").strip().capitalize()
    if b_status == "Absent":
        p1_triggers += 3
        justifications.append("Cardiac/Respiratory Arrest: Patient breathing reported absent. Immediate CPR & ALS ventilator mandatory.")
    elif b_status == "Difficult":
        p1_triggers += 1
        justifications.append("Severe Respiratory Distress: Patient experiencing labored or compromised breathing.")

    # Rule 3: Cardiovascular Red Flags
    if chest_pain:
        p1_triggers += 1
        recommended_specialty = "Cardiology"
        if patient_age and patient_age >= 40:
            p1_triggers += 1
            justifications.append(f"Acute Coronary Syndrome Risk: Acute chest pain in adult patient (age {patient_age}). ALS 12-lead ECG required.")
        else:
            justifications.append("Acute Cardiovascular Alert: Severe chest pain with potential ischemia risk.")

    # Rule 4: Stroke Protocol (FAST Heuristic)
    if suspected_stroke:
        p1_triggers += 1
        recommended_specialty = "Stroke Unit"
        justifications.append("Acute Neurovascular Alert: Stroke signs detected (FAST protocol). Time-sensitive thrombolytic window.")

    # Rule 5: Hemorrhage Control
    if severe_bleeding:
        p1_triggers += 1
        recommended_specialty = "Trauma Level 1"
        justifications.append("Major Hemorrhage Flag: Uncontrolled arterial or active severe bleeding requiring rapid hemostasis.")

    # Rule 6: Major Trauma
    if severe_trauma:
        p1_triggers += 1
        recommended_specialty = "Trauma Level 1"
        justifications.append("High-Energy Trauma: Severe structural mechanism or blunt force injury requiring Level 1/2 trauma resuscitation.")

    # Rule 7: Chief Complaint Keywords Triggering Rule Elevators
    p1_keywords = ["cardiac arrest", "unconscious", "not breathing", "choking", "drowning", "electrocution", "crush injury", "gunshot"]
    for kw in p1_keywords:
        if kw in complaint_lower:
            p1_triggers += 1
            justifications.append(f"High-Acuity Keyword Match: '{kw}' detected in emergency dispatch narrative.")
            break

    p2_keywords = ["fracture", "deep cut", "burn", "seizure", "asthma", "poisoning", "fall", "fainting", "head injury"]
    for kw in p2_keywords:
        if kw in complaint_lower and p1_triggers == 0:
            p2_triggers += 1
            if "burn" in kw:
                recommended_specialty = "Burn Care"
            elif "head" in kw:
                recommended_specialty = "Neurosurgery"
            justifications.append(f"Urgent Care Keyword Match: '{kw}' identified in emergency narrative.")
            break

    # Age vulnerability modifier
    if patient_age is not None:
        if patient_age < 5:
            recommended_specialty = "Pediatrics"
            if p1_triggers > 0 or p2_triggers > 0:
                justifications.append(f"Pediatric Vulnerability Factor: Age {patient_age} requires specialized pediatric resuscitation protocol.")
        elif patient_age > 75 and (p1_triggers > 0 or p2_triggers > 0):
            justifications.append(f"Geriatric Acuity Factor: Age {patient_age} carries elevated hemodynamic fragility.")

    # Triage Categorization Decision Logic
    if p1_triggers >= 1:
        triage_level = "Priority 1 (Critical)"
        triage_color = "RED"
        triage_score = min(100, 80 + (p1_triggers * 5))
        required_ambulance_type = "ALS"
    elif p2_triggers >= 1:
        triage_level = "Priority 2 (Urgent)"
        triage_color = "YELLOW"
        triage_score = min(79, 50 + (p2_triggers * 10))
        required_ambulance_type = "ALS" if p2_triggers >= 2 else "BLS"
    else:
        triage_level = "Priority 3 (Standard)"
        triage_color = "GREEN"
        triage_score = 30
        required_ambulance_type = "BLS"
        if not justifications:
            justifications.append("Stable Presentation: Patient alert with intact airway, normal breathing, and no active red flags.")

    return TriageAssessmentResult(
        triage_level=triage_level,
        triage_color=triage_color,
        triage_score=triage_score,
        required_ambulance_type=required_ambulance_type,
        justifications=justifications,
        recommended_specialty=recommended_specialty,
    )
