import pytest
from backend.app.services.triage_engine import assess_incident_severity

def test_triage_critical_respiratory_arrest():
    result = assess_incident_severity(
        chief_complaint="Patient collapsed suddenly and is not breathing",
        consciousness_level="Unresponsive",
        breathing_status="Absent",
    )
    assert result.triage_color == "RED"
    assert "Priority 1" in result.triage_level
    assert result.triage_score >= 90
    assert result.required_ambulance_type == "ALS"
    assert any("Cardiac/Respiratory Arrest" in j for j in result.justifications)
    assert any("Unresponsive" in j for j in result.justifications)

def test_triage_acute_cardiac_with_age():
    result = assess_incident_severity(
        chief_complaint="Severe crushing chest pain radiating to left arm",
        consciousness_level="Alert",
        breathing_status="Difficult",
        chest_pain=True,
        patient_age=55,
    )
    assert result.triage_color == "RED"
    assert "Priority 1" in result.triage_level
    assert result.required_ambulance_type == "ALS"
    assert result.recommended_specialty == "Cardiology"
    assert any("Acute Coronary Syndrome" in j for j in result.justifications)

def test_triage_stroke_symptoms():
    result = assess_incident_severity(
        chief_complaint="Sudden facial drooping and slurred speech",
        consciousness_level="Voice",
        suspected_stroke=True,
    )
    assert result.triage_color == "RED"
    assert result.required_ambulance_type == "ALS"
    assert result.recommended_specialty == "Stroke Unit"
    assert any("FAST protocol" in j for j in result.justifications)

def test_triage_urgent_fracture():
    result = assess_incident_severity(
        chief_complaint="Fell from stairs, painful closed arm fracture",
        consciousness_level="Alert",
        breathing_status="Normal",
        severe_bleeding=False,
    )
    assert result.triage_color == "YELLOW"
    assert "Priority 2" in result.triage_level
    assert result.triage_score < 80
    assert any("Urgent Care Keyword Match" in j for j in result.justifications)

def test_triage_standard_minor_injury():
    result = assess_incident_severity(
        chief_complaint="Mild ankle twist while walking, no swelling, fully conscious",
        consciousness_level="Alert",
        breathing_status="Normal",
    )
    assert result.triage_color == "GREEN"
    assert "Priority 3" in result.triage_level
    assert result.required_ambulance_type == "BLS"
    assert any("Stable Presentation" in j for j in result.justifications)

def test_triage_disclaimer_present():
    result = assess_incident_severity(chief_complaint="Routine pain")
    d = result.to_dict()
    assert "disclaimer" in d
    assert "Not clinically validated" in d["disclaimer"]
